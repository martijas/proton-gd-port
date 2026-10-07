// The game events (GJGameEvent) the simulation raises for the Event trigger
// (3604), by the game's numbers. The rest of the list is in
// GJBaseGameLayer::gameEventToString; the button and pickup events are in
// triggers/runtime.ts. [gdp GJBaseGameLayer::gameEventToString :428543-428793]

export const EVENT_TINY_LANDING = 1;
export const EVENT_FEATHER_LANDING = 2;
export const EVENT_SOFT_LANDING = 3;
export const EVENT_NORMAL_LANDING = 4;
export const EVENT_HARD_LANDING = 5;
export const EVENT_HIT_HEAD = 6;
export const EVENT_ORB_TOUCHED = 7;
export const EVENT_ORB_ACTIVATED = 8;
export const EVENT_PAD_ACTIVATED = 9;
export const EVENT_GRAVITY_INVERTED = 10;
export const EVENT_GRAVITY_RESTORED = 11;
export const EVENT_NORMAL_JUMP = 12;
export const EVENT_ROBOT_BOOST_START = 13;
export const EVENT_ROBOT_BOOST_STOP = 14;
export const EVENT_UFO_JUMP = 15;
/** Named in gameEventToString; the decompile never raises it. */
export const EVENT_SHIP_BOOST_START = 16;
/** Named in gameEventToString; the decompile never raises it. */
export const EVENT_SHIP_BOOST_END = 17;
export const EVENT_SPIDER_TELEPORT = 18;
export const EVENT_BALL_SWITCH = 19;
export const EVENT_SWING_SWITCH = 20;
export const EVENT_WAVE_PUSH = 21;
export const EVENT_WAVE_RELEASE = 22;
export const EVENT_DASH_START = 23;
export const EVENT_DASH_STOP = 24;
export const EVENT_TELEPORTED = 25;
export const EVENT_PORTAL_CUBE = 26;
export const EVENT_PORTAL_SHIP = 27;
export const EVENT_PORTAL_BALL = 28;
export const EVENT_PORTAL_UFO = 29;
export const EVENT_PORTAL_WAVE = 30;
export const EVENT_PORTAL_ROBOT = 31;
export const EVENT_PORTAL_SPIDER = 32;
export const EVENT_PORTAL_SWING = 33;
export const EVENT_PORTAL_GRAVITY_FLIP = 50;
export const EVENT_PORTAL_GRAVITY_NORMAL = 51;
export const EVENT_PORTAL_GRAVITY_INVERT = 52;
export const EVENT_PORTAL_MIRROR_ON = 53;
export const EVENT_PORTAL_MIRROR_OFF = 54;
export const EVENT_PORTAL_SCALE_NORMAL = 55;
export const EVENT_PORTAL_SCALE_MINI = 56;
export const EVENT_PORTAL_DUAL_ON = 57;
export const EVENT_PORTAL_DUAL_OFF = 58;
export const EVENT_PORTAL_TELEPORT = 59;
export const EVENT_CHECKPOINT = 60;
export const EVENT_CHECKPOINT_RESPAWN = 64;
export const EVENT_FALL_LOW = 65;
export const EVENT_FALL_MED = 66;
export const EVENT_FALL_HIGH = 67;
export const EVENT_FALL_VHIGH = 68;
export const EVENT_FALL_SPEED_LOW = 76;
export const EVENT_FALL_SPEED_MED = 77;
export const EVENT_FALL_SPEED_HIGH = 78;

/** Mode portal → GJGameEvent. [gdp gameEventToString :428631-428654] */
export const MODE_PORTAL_EVENTS: Readonly<Record<string, number>> = {
  cube: EVENT_PORTAL_CUBE,
  ship: EVENT_PORTAL_SHIP,
  ball: EVENT_PORTAL_BALL,
  ufo: EVENT_PORTAL_UFO,
  wave: EVENT_PORTAL_WAVE,
  robot: EVENT_PORTAL_ROBOT,
  spider: EVENT_PORTAL_SPIDER,
  swing: EVENT_PORTAL_SWING,
};

/**
 * Each orb's own event, raised beside Orb Activated. The game looks it up by
 * object type in a table the decompile does not have (objectTypeToGameEvent,
 * unk_982ED8); the event names follow the object types one for one.
 * [gdp PlayerObject::ringJump :159920-159926; objectTypeToGameEvent
 *  :428518-428527; the names :428655-428686]
 */
export const ORB_EVENTS: Readonly<Record<string, number>> = {
  yellow: 34,
  pink: 35,
  red: 36,
  blue: 37,
  green: 38,
  black: 39,
  toggle: 40,
  dash: 41,
  dashGravity: 42,
  spider: 43,
  teleport: 44,
};

/** Each pad's own event, raised beside Pad Activated (the blue pad's alone). [gdp GJBaseGameLayer::bumpPlayer :463199-463202; gravBumpPlayer :463256] */
export const PAD_EVENTS: Readonly<Record<string, number>> = {
  yellow: 45,
  pink: 46,
  red: 47,
  blue: 48,
  spider: 49,
};
