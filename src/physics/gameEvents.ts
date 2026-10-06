// The game events (GJGameEvent) the simulation raises for the Event trigger
// (3604), by the game's numbers. The rest of the list is in
// GJBaseGameLayer::gameEventToString; the button and pickup events are in
// triggers/runtime.ts. [gdp GJBaseGameLayer::gameEventToString :428543-428793]

export const EVENT_TINY_LANDING = 1;
export const EVENT_FEATHER_LANDING = 2;
export const EVENT_SOFT_LANDING = 3;
export const EVENT_NORMAL_LANDING = 4;
export const EVENT_HARD_LANDING = 5;
export const EVENT_ORB_TOUCHED = 7;
export const EVENT_ORB_ACTIVATED = 8;
export const EVENT_PAD_ACTIVATED = 9;
export const EVENT_NORMAL_JUMP = 12;
export const EVENT_ROBOT_BOOST_START = 13;
export const EVENT_ROBOT_BOOST_STOP = 14;
export const EVENT_BALL_SWITCH = 19;

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
