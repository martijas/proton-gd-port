/**
 * Physics constants for Geometry Dash 2.2.
 *
 * Units follow the game's own code so the decompiled formulas can be applied
 * verbatim:
 *  - positions in units (1 block = 30 units, +y up)
 *  - velocities in units per 60 fps frame ("Vel", m_yVelocity)
 *  - accelerations in units per frame² (m_gravity)
 *  - `dt` passed to PlayerObject::update is 0.25 per 240 Hz tick; updateJump
 *    and the y-integration receive dt * 0.9 (PlayerObject::update, matcool
 *    decomp), horizontal / wave / dash motion use the unscaled dt.
 *
 * Sources (see scratch/decomp for the raw files):
 *  [gdp]   camila314/gdp branch 2.2 — PlayerObject_updateJump/updateTimeMod/
 *          boostPlayer/updateRotation/updateShipRotation/runBallRotation/
 *          collidedWithObjectInternal/collidedWithSlopeInternal,
 *          GameObject_slopeYPos, GJBaseGameLayer_update
 *  [mat]   matcool/gd-decomps PlayerObject_update.cpp
 *  [boom]  boomlings.dev player_physics reference (measured in 2.2 @ 240 tps)
 *  [wiki]  geometrydash.wiki.gg / fandom Portals pages
 *  [meas]  our own measurement / tuning — flagged, revisit against the real game
 */

import type { GameMode, Level, Speed } from "../level/types";

// --- time --------------------------------------------------------------------

/** dt handed to PlayerObject::update per 240 Hz tick, in 60 fps frames. [gdp GJBaseGameLayer_update] */
export const FRAME_DT = 0.25;
/** updateJump(dt * 0.9) and y += dt * 0.9 * yVel. [mat] */
export const JUMP_DT_SCALE = 0.9;
/**
 * The effective dt for gravity and y-integration per tick: a float, which is
 * what updateJump receives and what update multiplies the y velocity by —
 * 0.22499999403953552, not 0.225. [gdp PlayerObject::update `float v24 = a2 *
 * 0.9`, gd-ida-decomp.cpp:161030-161031, 161040]
 */
export const JUMP_DT = Math.fround(FRAME_DT * JUMP_DT_SCALE);
/**
 * update holds the y velocity to this either way before anything reads it,
 * writing the double directly. [gd-ida-decomp.cpp:160995-161003]
 */
export const Y_VELOCITY_LIMIT = 1000;
/** Ticks per real second. */
export const TICKS_PER_SECOND = 240;

// --- speed portals -----------------------------------------------------------

export interface SpeedParams {
  /** m_playerSpeed */
  playerSpeed: number;
  /** m_yStart: cube jump velocity at this speed. */
  yStart: number;
  /** m_gravity for cube/robot at this speed (ball/spider/flying use FLYING_GRAVITY). */
  gravity: number;
  /** m_speedMultiplier: x per frame = playerSpeed * speedMultiplier. */
  speedMultiplier: number;
}

/**
 * Indexed by Speed (0 = 0.5x … 4 = 4x). m_playerSpeed (+2020) is a float; the
 * other three (+1568, +1576, +1560) are doubles the game writes as 8-byte
 * immediates — at 1x the widened floats 11.18003178, 0.958199024 and
 * 5.77000189, at every other speed the nearest doubles to the decimals here.
 * 4x shares the 3x row. [gdp PlayerObject::updateTimeMod, gd-ida-decomp.cpp:
 * 150522-150560, 1x 0x40265C2D20000000 / 0x3FEEA99100000000 /
 * 0x4017147B60000000; all twelve doubles are in the 2.2081 GeometryDash.exe,
 * once each, file offsets 0x3a035e-0x3a0442]
 */
export const SPEED_PARAMS: Record<Speed, SpeedParams> = {
  0: { playerSpeed: Math.fround(0.7), yStart: 10.620032, gravity: 0.940199, speedMultiplier: 5.980002 },
  1: { playerSpeed: Math.fround(0.9), yStart: 11.180031776428223, gravity: 0.9581990242004395, speedMultiplier: 5.7700018882751465 },
  2: { playerSpeed: Math.fround(1.1), yStart: 11.420032, gravity: 0.957199, speedMultiplier: 5.870002 },
  3: { playerSpeed: Math.fround(1.3), yStart: 11.230032, gravity: 0.961199, speedMultiplier: 6.000002 },
  4: { playerSpeed: Math.fround(1.6), yStart: 11.230032, gravity: 0.961199, speedMultiplier: 6.000002 },
};

/**
 * x speed in units per 60 fps frame for a speed index (5.193 at 1x → 311.58
 * u/s): getCurrentXVelocity, the float speed times the double multiplier.
 * [gd-ida-decomp.cpp:142060-142072]
 */
export function xSpeedFor(speed: Speed): number {
  const p = SPEED_PARAMS[speed];
  return p.playerSpeed * p.speedMultiplier;
}

/**
 * Gravity for the ball, the spider and every flying mode, whatever the speed:
 * the float 0.958199024, which is the 1x gravity's own value. The decompile
 * prints it as 0.9582, as it prints π/180 as 0.017453.
 * [gdp updateJump, gd-ida-decomp.cpp:155463-155464; GeometryDash.exe .rdata,
 *  bytes 88 4c 75 3f]
 */
export const FLYING_GRAVITY = Math.fround(0.958199024);

// --- size --------------------------------------------------------------------

/**
 * Mini player scale, +2016, which every box is measured by: 18 for a 30 box,
 * 16.2 for the spider's 27, 6 for the wave's 10.
 * [gdp PlayerObject::togglePlayerScale, gd-ida-decomp.cpp:150398, 150441-150442]
 */
export const MINI_SCALE = 0.6;
/** v20: cube/ball/robot/spider jump velocities, pads and orbs × the float 0.8 when mini. [gdp updateJump :155473-155475] */
export const MINI_JUMP_FACTOR = Math.fround(0.8);
/** Mini ship/UFO divide gravity terms and caps by the float 0.85. [gdp updateJump :155485] */
export const MINI_FLY_DIVISOR = Math.fround(0.85);

// --- cube / robot / ball / spider (ground modes) -------------------------------

/** Falling clamp for ground modes (max(yVel, -15) / min(yVel, 15) when flipped). [gdp] */
export const GROUND_MODE_TERMINAL_VELOCITY = 15;
/** v18 in updateJump: the gravity multiplier per mode, a float. [gdp updateJump :155733-155740] */
export const GRAVITY_FACTOR: Record<GameMode, number> = {
  cube: 1,
  robot: Math.fround(0.9),
  ball: Math.fround(0.6),
  spider: Math.fround(0.6),
  swing: Math.fround(0.6), // only used in the non-flying branch, which swing never takes
  ship: 1,
  ufo: 1,
  wave: 1,
};
/** Robot: jump velocity is yStart * 0.5. [gdp] */
export const ROBOT_JUMP_FACTOR = 0.5;
/**
 * Robot hold: gravity is cancelled while the accumulator is below this and the
 * hold has not already been ended; the accumulator, a double, takes
 * (float)(dt × 0.1) a tick (dt = JUMP_DT), so the window is 67 ticks, 0.28 s.
 *
 * The hold belongs to a ground jump alone. Releasing the button ends it
 * (`Player.robotHoldEnded`), and so does a yellow, pink, red or spider pad —
 * but only in a level with kA34 or in platformer; the blue pad never does.
 * Only the next ground jump gives it back, and entering robot or spider mode
 * starts the accumulator here — spent. An orb does neither, so holding through
 * one buys no height.
 * [gdp updateJump 155920-155928; releaseButton :159517; toggleRobotMode :153225;
 *  bumpPlayer :157053-157054; +2408 = !kA34 at :430562-430563]
 */
export const ROBOT_HOLD_LIMIT = 1.5;
export const ROBOT_HOLD_ACCUM_FACTOR = 0.1;
/**
 * Ball click: setYVelocity(flipMod * yStart * v16), flipGravity, then yVel *= 0.6.
 * The flip is what supplies the other half — boomlings measures the resulting
 * velocity as 0.3 × yStart (3.354 at 1x), which is 0.6 after flipGravity has
 * already halved it. There is no second constant here any more; see
 * GRAVITY_FLIP_VELOCITY_FACTOR. The 0.6 is a float, and it is written to the
 * double directly, so the result is not rounded to thousandths.
 * [gdp PlayerObject::updateJump, gd-ida-decomp.cpp:155855-155862][boom]
 */
export const BALL_CLICK_FACTOR = Math.fround(0.6);
// --- ship --------------------------------------------------------------------

/**
 * Ship/UFO/swing velocity caps: 8 up and 0.8 × 8 down, each over the size
 * factor (MINI_FLY_DIVISOR when mini) and each rounded to a float — 8 and
 * −6.4000001 at full size, 9.4117641 and −7.5294118 mini, ±8 for the swing.
 * The band the accelerating flag waits for is the same pair, whatever the
 * mode. [gdp updateJump, gd-ida-decomp.cpp:155485-155487 (the band),
 * 155560-155593 (the caps)]
 */
export const FLY_MAX_UP = 8;
export const FLY_MAX_DOWN_FACTOR = Math.fround(0.8);
/** Ship gravity factors: v51 (direction/strength) and v52 (base). [gdp updateJump ship branch] */
export const SHIP_HOLD_RISING = Math.fround(0.8); // holding while accelerating up
export const SHIP_HOLD = -1; // holding otherwise (sign flips the term → thrust)
export const SHIP_RELEASE_RISING = Math.fround(1.2); // released, moving up (not falling-bugged)
export const SHIP_RELEASE_FALLING = Math.fround(0.8);
/** v73 while the button is held and playerIsFallingBugged. [gd-ida-decomp.cpp:155527-155531] */
export const SHIP_BASE_FALLING = 0.5;
export const SHIP_BASE = Math.fround(0.4);
/** Platformer ship gravity × the float 0.8. [gd-ida-decomp.cpp:155523-155524] */
export const SHIP_PLATFORMER_GRAVITY = Math.fround(0.8);
/** Ship tilt slerp factor per frame. [gdp updateShipRotation] */
export const SHIP_ROTATION_INTERP = 0.15;

// --- ufo ---------------------------------------------------------------------

/** Fresh press sets yVel = flipMod * 7 * v16 (mini: the float 8 × 0.85 = 6.8000002) if that beats the current velocity. [gdp updateJump :155692-155706] */
export const UFO_JUMP_VELOCITY = 7;
export const UFO_JUMP_VELOCITY_MINI_BASE = 8;
/** UFO gravity: FLYING_GRAVITY * (rising ? 1.2 : 0.8) * 0.5 / v16. [gdp] */
export const UFO_GRAVITY_RISING = Math.fround(1.2);
export const UFO_GRAVITY_FALLING = Math.fround(0.8);
export const UFO_GRAVITY_BASE = 0.5;
/** UFO slope bonus: + slopeVelocity * 0.5, capped at 1.4 × jump. [gdp] */
export const UFO_SLOPE_BONUS = 0.5;
export const UFO_TILT_SCALE = -0.4;
export const UFO_TILT_CLAMP_RAD = 0.1;
export const UFO_ROTATION_INTERP = 0.07;

// --- wave --------------------------------------------------------------------

/** Wave y per tick = ±xSpeed * (mini ? 2 : 1) * FRAME_DT (unscaled dt, exact 45°). [gdp][mat] */
export const WAVE_MINI_SLOPE = 2;
export const WAVE_ROTATION_INTERP = 0.25;
export const WAVE_ROTATION_INTERP_MINI = 0.4;

// --- swing -------------------------------------------------------------------

/** Swing gravity factor (mini 0.6), constant, no hold. [gdp] */
export const SWING_GRAVITY = Math.fround(0.4);
export const SWING_GRAVITY_MINI = Math.fround(0.6);
/** Fresh press: flipGravity then yVel = (float)yVel × 0.8. [gdp updateJump :155606-155615][boom] */
export const SWING_CLICK_FACTOR = Math.fround(0.8);
export const SWING_MAX_VELOCITY = 8;

// --- ground contact ----------------------------------------------------------

/**
 * hitGround arms the jump latch only when the contact came in no faster than
 * this against gravity (yVel × flipMod). A landing arrives at 0 or below and
 * always arms it; a head-side contact faster than this does not.
 * [gdp PlayerObject::hitGround, gd-ida-decomp.cpp:150025, 150166-150170]
 */
export const LANDING_LATCH_MAX_VELOCITY = 5;

/**
 * How long after a gravity flip or a mode change a cube or robot that meets a
 * dual band edge head first is pushed back instead of going out of bounds.
 * Seconds; the game passes it as a float.
 * [gdp PlayerObject::isSafeHeadTest, gd-ida-decomp.cpp:147910-147912]
 */
export const SAFE_HEAD_SECONDS = 0.2;

// --- letter blocks -----------------------------------------------------------

/**
 * What touching a D, J, H or F block sets its counter to. Every update takes
 * one off, so the block still counts in the pass after the player leaves it.
 * [gdp PlayerObject::touchedObject, gd-ida-decomp.cpp:159667-159716;
 *  updateStateVariables :153691-153705]
 */
export const LETTER_BLOCK_PASSES = 2;

// --- force blocks ------------------------------------------------------------

/**
 * What touching a force block or circle sets its counter (+2360) to, as a
 * letter block does. The update after the pass pushes with the vector the pass
 * added up; the one after that runs the push again with whatever the next pass
 * added — nothing, once the player has left, which still rounds the y
 * velocity. [gdp PlayerObject::touchedObject, gd-ida-decomp.cpp:159679;
 *  updateStateVariables :153707-153715; the push :161032]
 */
export const FORCE_BLOCK_PASSES = 2;
/** How long the vector one pass adds up may get, a float; a longer one is scaled back to it. [:159690-159698] */
export const FORCE_MAX_LENGTH = 9999;
/**
 * calculateForceToTarget's degrees to radians: π/180 as a float, like
 * DASH_DEG — the decompile prints it 0.017453, and GeometryDash.exe holds π/180
 * but no 0.017453. 90° of it is not quite π/2, so an upright block also
 * pushes −4.4e-8 of its strength sideways.
 * [gdp ForceBlockGameObject::calculateForceToTarget, gd-ida-decomp.cpp:313058]
 */
export const FORCE_DEG = Math.fround(Math.PI / 180);
/**
 * The share of the push's y part each mode takes — ship 0.47, UFO 0.58, swing
 * 0.4, ball and spider 0.6, robot 0.9, cube and wave all of it (the wave's y
 * velocity does not move it) — and the mini ship's, UFO's and swing's own:
 * the full-size share over 0.8 (the swing's over 0.65). Floats. The decompile
 * prints the mini three to five figures, 0.5875, 0.725 and 0.61538;
 * GeometryDash.exe holds the quotients' floats (3f166666, 3f399999, 3f1d89d9)
 * and neither 0.725's nor 0.61538's.
 * [gdp PlayerObject::update, gd-ida-decomp.cpp:161359-161396]
 */
export const FORCE_MODE_FACTOR: Record<GameMode, number> = {
  cube: 1,
  ship: Math.fround(0.47),
  ball: Math.fround(0.6),
  ufo: Math.fround(0.58),
  wave: 1,
  robot: Math.fround(0.9),
  spider: Math.fround(0.6),
  swing: Math.fround(0.4),
};
export const FORCE_MODE_FACTOR_MINI: Partial<Record<GameMode, number>> = {
  ship: Math.fround(Math.fround(0.47) / Math.fround(0.8)),
  ufo: Math.fround(Math.fround(0.58) / Math.fround(0.8)),
  swing: Math.fround(Math.fround(0.4) / Math.fround(0.65)),
};
/**
 * A push away from the floor adds v / 12.94 × 1.5 to the robot's hold
 * accumulator, whatever the mode. Upright that spends the hold; upside down v
 * is negative, and the push gives the hold back.
 * [gd-ida-decomp.cpp:161405-161424]
 */
export const FORCE_ROBOT_HOLD_DIVISOR = Math.fround(12.94);
export const FORCE_ROBOT_HOLD_FACTOR = 1.5;
/** A platformer cube pushed sideways harder than this starts spinning. [gd-ida-decomp.cpp:161419-161420] */
export const FORCE_SPIN_MIN_X = 0.1;
/**
 * A platformer push slides out (+2372) until the x velocity is under this.
 * [PlayerObject::updateMove, gd-ida-decomp.cpp:149260-149261]
 */
export const FORCE_SLIDE_END = 0.5;
/**
 * The share of the x velocity a sliding push loses per 60th of a step: the
 * float 0.05 with boost slide (+2072) or a button held, the float 0.2 without.
 * [updateMove :149271-149281]
 */
export const FORCE_SLIDE_EASE = Math.fround(0.05);
export const FORCE_SLIDE_EASE_FREE = Math.fround(0.2);
/** Under the float 0.01 the ease stops the player outright. [updateMove :149448-149450] */
export const FORCE_SLIDE_STOP = Math.fround(0.01);

// --- squeeze -----------------------------------------------------------------

/**
 * A player with a floor and a ceiling met in one pass closer than this share
 * of its height is squeezed: 0.7, 0.8 in a platformer. Floats.
 * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158534-158537]
 */
export const SQUEEZE_FACTOR = Math.fround(0.7);
export const SQUEEZE_FACTOR_PLATFORMER = Math.fround(0.8);
/**
 * A squeezed platformer player first tries eight places beside it, 3, 6, 9
 * and 12 units right and left, right first; one squeezed between walls, above
 * and below it, up first. [gd-ida-decomp.cpp:158605-158657, 158757-158810]
 */
export const SQUEEZE_NUDGE = 3;
export const SQUEEZE_NUDGE_TRIES = 8;
/**
 * A platformer player with a wall on each side closer than its width less
 * this × its scale is squeezed: 25 apart at full size, 15 mini.
 * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158743]
 */
export const SQUEEZE_WALL_MARGIN = 5;

// --- rotation ----------------------------------------------------------------

/**
 * The seconds runNormalRotation gives the cube for half a turn: 0.43333 at
 * full size, 0.33333 at any other scale — 415.4°/s and 540°/s. The rate is
 * a float, 180 / these, and it is signed by the direction, the gravity and
 * rotated gameplay, and scaled by the gravity multiplier.
 * [gdp PlayerObject::runNormalRotation, gd-ida-decomp.cpp:144512-144540]
 */
export const CUBE_SPIN_SECONDS = Math.fround(0.43333);
export const CUBE_SPIN_SECONDS_MINI = Math.fround(0.33333);
/** Landing: slerp toward the nearest 90° with t = min(dt, dt * playerSpeed * 0.175) (×3 on ground, ×0.5 ship, ×0.5 robot/spider air). [gdp updateRotation] */
export const ROTATION_SLERP_BASE = 0.175;
export const ROTATION_SLERP_GROUND_MULT = 3;
export const ROTATION_SLERP_SHIP_MULT = 0.5;
/** Ball roll on the ground: 120 / v5 deg/s, v5 = (mini ? 0.16 : 0.2) × speed factor. [gdp runBallRotation] */
export const BALL_ROLL_BASE = 120;
export const BALL_ROLL_V5 = 0.2;
export const BALL_ROLL_V5_MINI = 0.16;
export const BALL_ROLL_SPEED_FACTOR: Record<Speed, number> = {
  0: 1.2405638,
  1: 1,
  2: 0.80424345,
  3: 0.6657693,
  4: 0.5409375,
};
/**
 * Ball roll in the air, after a flip or an orb: −340 / v5 deg/s, v5 = (mini ?
 * 0.64 : 0.8) × the same speed factor — −425°/s at full size and speed 1.
 * [gdp PlayerObject::runBallRotation2, gd-ida-decomp.cpp:143785-143826]
 */
export const BALL_AIR_ROLL_BASE = -340;
export const BALL_AIR_ROLL_V5 = 0.8;
export const BALL_AIR_ROLL_V5_MINI = 0.64;
/**
 * The seconds boostPlayer gives the cube for half a turn *backwards* when a
 * slope launches it: 0.86667 at full size, 0.66667 at any other scale —
 * −207.7°/s and −270°/s, signed by the gravity alone. Pads and orbs spin at
 * the ordinary rate instead.
 * [gdp PlayerObject::boostPlayer, gd-ida-decomp.cpp:147590-147598]
 */
export const BOOST_SPIN_SECONDS = Math.fround(0.86667);
export const BOOST_SPIN_SECONDS_MINI = Math.fround(0.66667);

// --- hitboxes ----------------------------------------------------------------

/**
 * The player's box before its scale (+648/+652): 30, except for the spider and
 * the wave, whose toggles write their own and whose off toggles put 30 back.
 * Every contact is measured by this times the vehicle scale — 18, 16.2 and 6
 * when mini. [gdp resetPlayerIcon, gd-ida-decomp.cpp:148112-148114;
 * toggleSpiderMode :152721-152723; toggleDartMode :153041-153043]
 */
export const PLAYER_HITBOX = 30;
export const SPIDER_HITBOX = 27;
export const WAVE_HITBOX = 10;
/**
 * +2160, the size the ground and the dual band measure a wave by: 20, where
 * its box is 10, so a wave rides 10 units off the floor (mini 6). Every other
 * mode's is its box. [gdp toggleDartMode, gd-ida-decomp.cpp:153041;
 * checkCollisions :464678-464690]
 */
export const WAVE_GROUND_SIZE = 20;
/**
 * Inner solid-death rect = getObjectRect(0.3, 0.3): 0.3 of the unscaled box,
 * because that overload never reads the vehicle scale — 9 for every mode at
 * both sizes, but the spider's 8.1 and the wave's 3.
 * [gdp GameObject::getObjectRect(float, float), gd-ida-decomp.cpp:170812-170848;
 *  called from collidedWithObjectInternal :152369]
 */
export const INNER_HITBOX_FACTOR = 0.3;

/**
 * snapUpThreshold for landing on block tops: 10 default, 6 for flying modes
 * outside platformer, 5 for a platformer player off slopes, and 15 for a
 * platformer player's first two passes after growing back from mini.
 * [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151513-151532]
 */
export const SNAP_THRESHOLD = 10;
export const SNAP_THRESHOLD_SCALED = 15;
export const SNAP_THRESHOLD_FLYING = 6;
export const SNAP_THRESHOLD_PLATFORMER = 5;

/**
 * How much a platformer player's box loses, half off each side, for solid
 * contacts: in width before a block's top or bottom can be met, in height
 * before its side can push. 0 outside a platformer.
 * [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151632-151634, used at
 *  :151741 and :152305]
 */
export const PLATFORMER_CONTACT_INSET = 5;
/**
 * A moving block coming toward the feet faster than this is met even by a
 * player moving away from it. [collidedWithObjectInternal, gd-ida-decomp.cpp:151607]
 */
export const PLATFORM_FAST_SPEED = 5;
/**
 * The moving-platform launch: last pass's platform speed above 5 and this
 * pass's lower by more than 0.5, capped at 20.
 * [PlayerObject::postCollision, gd-ida-decomp.cpp:159072-159116]
 */
export const PLATFORM_LAUNCH_MIN = 5;
export const PLATFORM_LAUNCH_DROP = 0.5;
export const PLATFORM_LAUNCH_CAP = 20;
/**
 * How many collision passes the 15-unit threshold lasts: togglePlayerScale
 * sets +2212 to 2 on growing back in a platformer and every update takes one
 * off, so it covers the portal's own pass and the next one.
 * [gdp PlayerObject::togglePlayerScale, gd-ida-decomp.cpp:150416-150418;
 *  updateStateVariables :153706]
 */
export const SCALE_SNAP_PASSES = 2;
/**
 * The game's isSafeFlip(0.1), in seconds: within this long of a gravity flip
 * an inner-hitbox overlap with a block above snaps under it instead of
 * killing, an upside-down player that reaches the plain ground is caught by
 * it instead of going out of bounds, and — with isSafeMode(0.1), a mode
 * change as recent — a cube that meets a ceiling slope is set on its
 * surface instead of dying.
 * [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:152374;
 *  GJBaseGameLayer::checkCollisions :464736; collidedWithSlopeInternal
 *  :157646-157667]
 */
export const POST_FLIP_SNAP_GRACE = 0.1;
/** Spider: trailing-side solid contact ignored for this long after a flip. [gdp] */
export const SPIDER_FLIP_GRACE = 0.04;
/** Side-collision handling treats the player as slope-related for this long after leaving a slope. [gdp] */
export const SLOPE_RECENT_EXIT_WINDOW = 0.2;

// --- the spider's jump ---------------------------------------------------------
// spiderTestJumpInternal's search, all in units along the gravity axis unless
// the name says otherwise. [gdp PlayerObject::spiderTestJumpInternal,
// gd-ida-decomp.cpp:154650-155238]

/**
 * How far the search reaches either way when no band bounds it — rotated
 * gameplay, a free-mode portal, or a cube or robot taken by a spider pad or orb,
 * band or not. It never goes below the ground (or, rotated, below x 0).
 * [:154751-154772; isInBasicMode :145589-145598]
 */
export const SPIDER_SEARCH_RANGE = 3000;
/** Width of the strip hazards are looked for in, centred on the player, × the vehicle scale. [:154751, 154844-154853] */
export const SPIDER_HAZARD_STRIP = 8;
/** The wider rect the search retries with: the player's own, 4 units longer on its right. [:154826-154843, 154929-154934] */
export const SPIDER_RETRY_WIDEN = 4;
/** A surface counts only if the landing centre is no more than this far behind the player's own. [:155034-155046] */
export const SPIDER_BEHIND_SLACK = 10;

// --- slopes ------------------------------------------------------------------

/**
 * m_slopeVelocity (+1956) = f(f(slopeYVelocity × 1.4) × min(f(0.8 / angle), 1.1))
 * × dir × flipMod; all three constants are doubles, the angle a float.
 * [gdp collidedWithSlopeInternal, gd-ida-decomp.cpp:157905-157913]
 */
export const SLOPE_EXIT_A = 0.8;
export const SLOPE_EXIT_CAP = 1.1;
export const SLOPE_EXIT_YVEL_FACTOR = 1.4;
/** Flying modes and ball: slope velocity × 0.75. [gdp] */
export const SLOPE_FLYING_BALL_FACTOR = 0.75;
/**
 * Jumping from a slope adds 0.25 × slope y velocity, capped at 1.4 × jump
 * velocity; the 1.4 is a float, and so is the cap it makes (v39 on the
 * ground, v87 for the UFO). [gdp updateJump :155707-155721, 155815-155848]
 */
export const SLOPE_JUMP_BONUS = 0.25;
export const SLOPE_JUMP_CAP = Math.fround(1.4);
/**
 * A platformer's ground jump takes the slope bonus only while its x speed is
 * above this; the UFO's hop takes it at any speed. [gd-ida-decomp.cpp:155820]
 */
export const SLOPE_JUMP_PLATFORMER_MIN_SPEED = 4;
/**
 * getModifiedSlopeYVel: a slope ridden for under 0.1 s only hands over part of
 * its velocity — the time on it × 10, never below 0.4, both limits floats, and
 * the result a float. [gdp PlayerObject::getModifiedSlopeYVel,
 * gd-ida-decomp.cpp:142596-142614]
 */
export const SLOPE_BOOST_RAMP_TIME = Math.fround(0.1);
export const SLOPE_BOOST_RAMP_RATE = 10;
export const SLOPE_BOOST_MIN_FACTOR = Math.fround(0.4);
/** Flying into a slope underside, or a cube set on a ceiling slope, clamps yVel to ∓2. [gdp; gd-ida-decomp.cpp:157652-157666] */
export const SLOPE_FLYING_CONTACT_CLAMP = 2;
/** Hazard slopes shift their surface by 4 units. [gdp GameObject_slopeYPos] */
export const SLOPE_HAZARD_SURFACE_OFFSET = 4;
/** Platformer: slopes ≥ 40° (ice) / ≥ 80° drop m_isOnGround. [gdp] */
export const SLOPE_PLATFORMER_ICE_ANGLE = 40;
export const SLOPE_PLATFORMER_STEEP_ANGLE = 80;

// --- pads ----------------------------------------------------------------------
// A pad sets 16 × what it is worth for the mode (getBumpMod), signed by
// gravity, × 0.8 when mini and × 0.6 for ball, spider and swing. Nothing is
// capped here: a flying player is held to its caps by the next updateJump
// unless the pad (the red one) set the accelerating flag — which is how the
// yellow pad's "16, then 8 on the next tick" comes about.
// [gdp PlayerObject::propellPlayer, gd-ida-decomp.cpp:147666-147712;
//  GJBaseGameLayer::getBumpMod :421316-421366]

/** propellPlayer's base velocity. [gd-ida-decomp.cpp:147691] */
export const PAD_BASE_VELOCITY = 16;
/** Ball, spider and swing leave a pad at this fraction, the float 0.6 written straight to the double. [147692-147693] */
export const PAD_SLOW_MODE_FACTOR = Math.fround(0.6);
/**
 * What gravBumpPlayer hands propellPlayer. The flip that follows halves the
 * launch, so a blue pad lands as the 6.4 boomlings measures (3.84 for ball,
 * spider and swing). [gd-ida-decomp.cpp:463253-463254]
 */
export const PAD_BLUE_BUMP = Math.fround(0.8);
/** getBumpMod for the pink pad; getBumpMod returns a float. [gd-ida-decomp.cpp:421322-421342] */
export const PAD_PINK_BUMP = {
  ship: Math.fround(0.35),
  ufo: Math.fround(0.4),
  ballOrSpider: Math.fround(0.7),
  other: Math.fround(0.65),
} as const;
/** getBumpMod for the red pad: the ship and UFO have their own numbers, mini or not. [421343-421362] */
export const PAD_RED_BUMP = {
  ship: Math.fround(0.63),
  shipMini: Math.fround(0.95),
  ufo: Math.fround(0.6),
  ufoMini: Math.fround(0.98),
  other: 1.25,
} as const;

// --- orbs --------------------------------------------------------------------
// ringJump sets flipMod × yStart × the orb's factor × 0.8 when mini — for the
// ship and UFO too, which are then held to their caps on the next tick unless
// the orb (the red one) set the accelerating flag. Ball and spider then keep
// 0.7 of it and the swing 0.6.
// [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:160141-160350]

/**
 * The orb's multiplier on the jump velocity, by mode: floats, which multiply
 * yStart taken as a float (ringJump's v23 and v24 are both floats). The blue
 * orb's 0.8 is written inline in that float product and is taken as the float
 * too. [gd-ida-decomp.cpp:160152-160221; blue :160158]
 */
export const ORB_FACTOR = {
  yellow: 1,
  yellowRobot: Math.fround(0.9),
  pink: Math.fround(0.72),
  pinkShip: Math.fround(0.37),
  pinkUfo: Math.fround(0.42),
  pinkBall: Math.fround(0.77),
  red: Math.fround(1.38),
  redRobot: Math.fround(1.28),
  redBallOrSpider: Math.fround(1.34),
  redShip: 1,
  redShipMini: Math.fround(1.4),
  redUfo: Math.fround(1.02),
  redUfoMini: Math.fround(1.36),
  blue: Math.fround(0.8),
  green: 1,
  greenShip: Math.fround(0.7),
} as const;
/** What ball and spider keep of an orb's launch: the float 0.7, raw on the double. [160272-160286, 160348] */
export const ORB_BALL_SPIDER_FACTOR = Math.fround(0.7);
/** What the swing keeps of it, the float 0.6. [160280-160282] */
export const ORB_SWING_FACTOR = Math.fround(0.6);
/**
 * The black orb: straight down at 15 in the ground modes (the spider × 1.1)
 * and 14 in the flying ones (the UFO × 0.8). [gd-ida-decomp.cpp:160352-160373]
 */
export const BLACK_ORB_VELOCITY = -15;
export const BLACK_ORB_FLYING_VELOCITY = -14;
export const BLACK_ORB_SPIDER_FACTOR = Math.fround(1.1);
export const BLACK_ORB_UFO_FACTOR = Math.fround(0.8);

// --- dash orbs ---------------------------------------------------------------

/**
 * π/180 as the float the game turns a dash's degrees into radians with; the
 * decompile prints it 0.017453. [startDashing, gd-ida-decomp.cpp:148608,
 * 148663, 148674]
 */
export const DASH_DEG = Math.fround(Math.PI / 180);
/**
 * The classic dash's clamp, on the orb's angle as it is placed, never
 * wrapped: past 70 either way it dashes at 70, on the side a raw test of the
 * angle picks (see SimImpl.classicDash). [startDashing,
 * gd-ida-decomp.cpp:148639-148690]
 */
export const DASH_MAX_ANGLE = 70;
/**
 * A platformer dash's speed per unit of its orb's speed (key 586): 5.77, the
 * 1x speed multiplier, whatever the portal speed. [startDashing,
 * gd-ida-decomp.cpp:148609]
 */
export const PLATFORMER_DASH_SPEED = Math.fround(5.77);
/**
 * The forced spin a platformer dash ends with, as a multiple of the cube's
 * rate: 2 from a dash speed of 17.31 (3 × 5.77) up, below that 0.5 + 1.5 ×
 * speed / 17.31. [stopDashing, gd-ida-decomp.cpp:149890-149898]
 */
export const DASH_SPIN_FULL_SPEED = 17.31;
export const DASH_SPIN_MAX_FACTOR = 2;
export const DASH_SPIN_SLOPE = 1.5;
export const DASH_SPIN_BASE = 0.5;

// --- gravity flips ------------------------------------------------------------

/**
 * y velocity multiplier applied whenever the player's gravity actually flips.
 *
 * This is not a portal rule. `PlayerObject::flipGravity` halves the velocity
 * itself, once, whenever the flag changes — in both directions and for every
 * caller: the two gravity portals, the green toggle portal, the blue orb and
 * pad, the green orb, the spider orb, the ball click, the swing click, the
 * teleport portal's own gravity setting and the dash-gravity orb. Most of those
 * write the velocity again straight afterwards, so the halving only shows where
 * nothing overwrites it.
 *
 * The number was already right for the wrong reason: it used to live at the
 * gravity-portal call site with a comment saying the body was not decompiled.
 * It is, and the halving is a plain `* 0.5` on the double at +1936.
 * [gdp PlayerObject::flipGravity, gd-ida-decomp.cpp:151156-151158]
 */
/**
 * y velocity multiplier applied by each of the four flying mode toggles.
 *
 * Separate from GRAVITY_FLIP_VELOCITY_FACTOR even though the number is the same:
 * this one is written by `toggleFlyMode` / `toggleBirdMode` / `toggleDartMode` /
 * `toggleSwingMode`, fires on both edges of the toggle, and composes with the
 * gravity one when a portal pair does both in the same frame. Roll, robot and
 * spider have no such line at all.
 * [gdp gd-ida-decomp.cpp:152586, 152819, 152930, 153032]
 */
export const FLY_TOGGLE_VELOCITY_FACTOR = 0.5;

export const GRAVITY_FLIP_VELOCITY_FACTOR = 0.5;

// --- play area ----------------------------------------------------------------

/** Ground top is at y = 0 in level space (objects sit at y = 15 for the first block row). */
export const FLOOR_Y = 0;
/** Where the game's own ground plane is: its y is level y + 90. */
export const GAME_GROUND_Y = 90;
/** Flying-mode corridor: floor-to-ceiling span in units (10 blocks). [wiki] */
export const FLY_CORRIDOR_HEIGHT = 300;
/** Ball corridor 8 blocks, spider 9 blocks. [wiki] */
export const BALL_CORRIDOR_HEIGHT = 240;
export const SPIDER_CORRIDOR_HEIGHT = 270;
/** Cube/robot have no ceiling in classic mode. */
export const OPEN_CEILING = Number.POSITIVE_INFINITY;
/** Level length padding after the last object before the end wall. [meas] */
export const LEVEL_END_PADDING = 30 * 12;

/**
 * How far above the ground the player may go before it dies.
 *
 * There is a real ceiling on every level and this port had none, so a player
 * whose gravity was flipped in a mode with no corridor simply fell upwards for
 * ever. Nothing stopped it and the level still counted x progress, so the
 * autoplayer "finished" Dash from 14,000 units up in empty sky.
 *
 * The game keeps two answers. Most levels get a flat ceiling, 2790 in the
 * game's units; a level that asks for the taller one gets its own highest
 * object plus a margin, with a floor under the whole thing so a short level
 * still has room. The camera reads the same value: the view's top stays 150
 * under it. The numbers below are shifted from the game's ground plane at 90
 * to this port's at 0.
 * [gdp GJBaseGameLayer::updateMaxGameplayY, gd-ida-decomp.cpp:430608-430651
 *  (float 2864, 1160667136 = 2790.0 at :430650); the kill test is in
 *  checkCollisions :464727-464732, the camera's in updateCamera :449595]
 */
export const MAX_GAMEPLAY_Y_DEFAULT = 2790 - 90;
/** The shortest the object-derived ceiling may be, before its margin. [gdp :430627] */
export const MAX_GAMEPLAY_Y_FLOOR = 1200 - 90;
/** Added above the highest object, or above that floor. [gdp :430646 `v6 + 90 + 300`] */
export const MAX_GAMEPLAY_Y_MARGIN = 390;

/**
 * Whether the level keeps its objects in rows as well as columns: a platformer
 * (kA22), or a level carrying kA37. It decides the order the collision pass
 * meets objects in, which of them it can meet at all, and the level's top.
 * [gdp LevelSettingsObject::shouldUseYSection, gd-ida-decomp.cpp:195727-195733;
 *  +281 = kA22 and +361 = kA37, read at :196181-196183, 196285-196287]
 */
export function usesYSections(level: Level): boolean {
  return level.header.platformer || level.header.ySections;
}

/**
 * The level's top (float 2864): how high the player may be before it counts as
 * out of bounds, and what the view stays under.
 *
 * Two answers, chosen by the same test that decides whether the level keeps
 * its objects in rows (usesYSections): a platformer, or a level carrying
 * `kA37`, measures its own contents; everything else takes the flat default.
 * In the official set that means Dash and the four tower floors, the only
 * levels whose art reaches above the flat ceiling — Dash goes to 3,195 and
 * The Cellar to 4,584, where no other level passes 2,146.
 *
 * [gdp GJBaseGameLayer::updateMaxGameplayY, gd-ida-decomp.cpp:430608-430651]
 */
export function maxGameplayYFor(level: Level): number {
  if (!usesYSections(level)) return MAX_GAMEPLAY_Y_DEFAULT;
  let highest = MAX_GAMEPLAY_Y_FLOOR;
  for (const o of level.objects) if (o.y > highest) highest = o.y;
  return highest + MAX_GAMEPLAY_Y_MARGIN;
}

/**
 * How far left of the start the player may go before it dies.
 *
 * Only reachable with reversed gameplay, which is the only way to travel left
 * in a classic level; a platformer clamps to this line instead of dying on it.
 * [gdp GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464708-464724]
 */
export const MIN_GAMEPLAY_X = -30;

// --- platformer ----------------------------------------------------------------
// The platformer branch of PlayerObject::update is not in the decomp set;
// these are measured against the real game and marked as such. [meas]

/** Max platformer x speed equals the classic x speed for the current speed portal. */
export const PLATFORMER_MAX_SPEED_FACTOR = 1;
/** Frames (60 fps) to reach full speed from rest on normal blocks. */
export const PLATFORMER_ACCEL_FRAMES = 6;
/** Frames to stop from full speed on normal blocks. */
export const PLATFORMER_DECEL_FRAMES = 6;
/** Ice blocks: acceleration and deceleration take this many times longer. */
export const PLATFORMER_ICE_FACTOR = 4;
/** Platformer regrounding delay after a landing (seconds). [gdp] */
export const PLATFORMER_LAND_DELAY = 0.05;

// --- physics core additions (src/physics/player.ts, collision.ts, sim.ts) ------

/**
 * Default spawn in classic levels: resting on the ground, not above it.
 *
 * The game's own number is 105, and copying it here was wrong: the game measures
 * from a ground plane at y = 90, so 105 puts the cube's feet exactly on the
 * floor. This port measures from a floor at y = 0 (`FLOOR_Y`, first block row at
 * 15), so the same position is 15. With 105 the cube fell 90 units — 60 ticks
 * and 79 units of level — at the start of every classic level.
 *
 * A mini player is deliberately left 6 units up, because the game does the same:
 * `togglePlayerScale` never moves the player, so its feet sit at 15 − 9 and it
 * drops. [gdp GJBaseGameLayer::checkCollisions floor snap `height*0.5 + 90.0`,
 * gd-ida-decomp.cpp:464689; measured here against level 1]
 */
export const PLAYER_START_X = 0;
export const PLAYER_START_Y = FLOOR_Y + PLAYER_HITBOX / 2;

/**
 * kA42 "Reverse Sync": the share of a player's reverse offset each step pays
 * off, as a fraction of that step's forward move — the float 0.02 widened, as
 * the game multiplies the double step by it. [gdp PlayerObject::update,
 * gd-ida-decomp.cpp:161105 (printed 0.0199999996)]
 */
export const REVERSE_SYNC_SHARE = Math.fround(0.02);

/**
 * Corridor floors snap down to whole block rows.
 *
 * This was tagged as measured here and doubted in the code that used it; it is
 * the game's own `floorf(y / 30.0) * 30.0`, and it is skipped only when a
 * camera-mode trigger asks for it to be. The game clamps the result to its
 * ground at 90 where this port clamps to 0, which is the same clamp: the game's
 * world is level y + 90 and 90 is a multiple of 30, so the shift commutes with
 * the snap. [gdp GJBaseGameLayer::animateInDualGroundNew,
 * gd-ida-decomp.cpp:451069-451075]
 */
export const CORRIDOR_GRID = 30;

/** playerIsFalling(-0.25): a cube falling faster than this starts the fall spin. [gdp updateJump line 462] */
export const FALL_SPIN_VELOCITY = -0.25;
/** Falling faster than this (gravity-relative) clears m_isOnGround2. [gdp updateJump line 466] */
export const FALL_UNGROUND2_VELOCITY = -4;

/** Robot/spider airborne rotation lerps toward 0 at half rate. [gdp updateRotation line 13] */
export const ROTATION_ROBOT_AIR_DT_MULT = 0.5;
/** Ship/wave/UFO tilt is skipped when the last tick's movement² < dt × this. [gdp updateShipRotation] */
export const SHIP_ROTATION_MIN_MOVE = 1.2;
/** Tilt interpolation is quartered while a flying player touches a slope. [gdp updateShipRotation] */
export const SHIP_ROTATION_SLOPE_FACTOR = 0.25;
/** Ball roll factor on a slope: 1/cos(slopeRot); above 2 it becomes 0.7x + 0.3. [gdp collidedWithSlopeInternal lines 277-279] */
export const BALL_SLOPE_ROLL_CAP = 2;
export const BALL_SLOPE_ROLL_SOFT_A = 0.7;
export const BALL_SLOPE_ROLL_SOFT_B = 0.3;

/** Slope attach tolerance above the surface when descending: 1 unit, 4 once already on a slope. [gdp collidedWithSlopeInternal line 27] */
export const SLOPE_ATTACH_TOLERANCE = 1;
export const SLOPE_ATTACH_TOLERANCE_ON_SLOPE = 4;
/** Flying + holding under a ceiling slope: tolerance 1 (2 once on it). [gdp collidedWithSlopeInternal line 97] */
export const SLOPE_FLY_HOLD_TOLERANCE = 1;
export const SLOPE_FLY_HOLD_TOLERANCE_ON_SLOPE = 2;
/** Entering a new opposite-facing slope straight from another one shrinks the radius by 20 × vehicleSize. [gdp line 67] */
export const SLOPE_NEW_SLOPE_OFFSET = 20;
/** Landing on a floor slope keeps an upward velocity above this instead of zeroing it. [gdp line 231] */
export const SLOPE_KEEP_RISING_VELOCITY = 5;
/** The first-contact test uses the slope rect shrunk by 1 unit top and bottom. [gdp lines 54-56] */
export const SLOPE_ENTRY_INSET = 1;
/** Solid-collision snap threshold grows by (radius/cos(angle) − radius) after a slope. [gdp collidedWithObjectInternal line 40] */
export const SLOPE_SNAP_EXTRA_SCALE = 1;

/**
 * An F block met head first turns the player over and sends it at 2 toward
 * its new floor, the block it has just met. [gdp PlayerObject::hardFlipGravity,
 * gd-ida-decomp.cpp:151223-151232, called from didHitHead :151248-151265]
 */
export const HEAD_SNAP_PUSH_VELOCITY = 2;

/**
 * checkSnapJumpToObject stair tables per m_playerSpeed: x tolerance and the
 * dx of a +1 block ("little"), −1 block ("down") and +2 block ("big") stair
 * that gets the landing x re-aligned. [gdp checkSnapJumpToObject]
 */
export interface StairSnap {
  threshold: number;
  littleStair: number;
  littleStairMini: number;
  downStair: number;
  bigStair: number;
}
export const STAIR_SNAP: Record<Speed, StairSnap> = {
  0: { threshold: 1, littleStair: 90, littleStairMini: 90, downStair: 120, bigStair: 60 },
  1: { threshold: 1, littleStair: 120, littleStairMini: 90, downStair: 150, bigStair: 90 },
  2: { threshold: 2, littleStair: 150, littleStairMini: 90, downStair: 195, bigStair: 120 },
  3: { threshold: 2, littleStair: 90, littleStairMini: 90, downStair: 225, bigStair: 135 },
  4: { threshold: 2, littleStair: 180, littleStairMini: 120, downStair: 225, bigStair: 90 },
};
/** The mini 4x row of the same table has its own thresholds. [gdp checkSnapJumpToObject] */
export const STAIR_SNAP_MINI_4X: StairSnap = { threshold: 1, littleStair: 120, littleStairMini: 120, downStair: 150, bigStair: 90 };

/** Spatial hash cell size for the static object index. [meas] */
export const SPATIAL_CELL = 60;

/**
 * The game keeps its objects in sections 100 units wide (and, in a platformer
 * or with kA37, 100 tall), and the collision pass meets them section by
 * section. This is the float the section index is taken with, as the game
 * stores it. [gdp GJBaseGameLayer +11448/+11452, gd-ida-decomp.cpp:461909-461910,
 *  430569-430572; addToSection :444742-444770]
 */
export const COLLISION_SECTION_SCALE = Math.fround(0.01);
