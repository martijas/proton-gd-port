// What this port has actually done about each trigger.
//
// The catalogue next door says what the game has; this says what we have. It is
// hand-written and every entry that is not "done" carries the reason, which is
// the point: an unimplemented trigger should be a counted gap, not a mystery to
// be rediscovered later as a bug report. The same discipline as the
// dropped-glow count in the asset build — the number is allowed to be bad, it
// is not allowed to be unknown.
//
// `npm run triggers` prints the coverage this drives, weighted by how often the
// official levels actually place each id.
//
// The four statuses mean exactly this:
//   done         implemented, and nothing about it is known to be missing
//   partial      fires and does most of its job; `note` says what it skips
//   todo         does nothing yet
//   unsupported  does nothing on purpose; `note` says why

import { TRIGGER_CATALOGUE, type TriggerInfo } from "./catalogue";

export type TriggerStatus = "done" | "partial" | "todo" | "unsupported";

export interface TriggerEntry {
  status: TriggerStatus;
  note?: string;
}

const DONE: TriggerEntry = { status: "done" };

/**
 * The enter effects. Read out of PlayLayer::applyEnterEffect: a 70-unit band
 * inside either screen edge, a 100-unit slide, a fade on every one of them,
 * and the same effect played back to front on the way off the left. Each
 * fills its channel's coming-in and going-out tables when it is reached, and
 * an object latches its own channel's entry as it starts to come in.
 */
const ENTER_TIMED: TriggerEntry = DONE;
/** The audio triggers: all of it plays but the reverb. */
const AUDIO: TriggerEntry = {
  status: "partial",
  note: "channels, preps, edits, proximity and the checkpoint replay are played; reverb (407, 502, 503) is not",
};
/** The Ghost Trail: the fading copies of the icon render/ghostTrail.ts draws behind the player, which these start and stop. */
const TRAIL: TriggerEntry = { status: "done", note: "fading copies of the icon follow the player while it is on" };
/**
 * The distortion shaders. Their keys, easing and layer range are read as the
 * game reads them and they switch the band on as the game's do, but the game's
 * shader is run with the distortion itself at its off value.
 */
const SHADER_UNDRAWN: TriggerEntry = {
  status: "partial",
  note: "the values, their easing and the layer range are the game's, and the band goes through the shader while it is on; the distortion itself is not drawn yet",
};
const AREA: TriggerEntry = { status: "todo", note: "the area triggers pick their objects at fire time; not built" };
/** Area Move, Rotate and Scale: worked out every step from each object's distance to the centre. */
const AREA_MOTION: TriggerEntry = {
  status: "partial",
  note: "falloff, easing, dual easing, variance, priority and the players or a group as centre are the game's; a screen-corner centre does nothing, group parents are not moved as one piece, and the variance table's seed is not the game's",
};
/** Area Fade and Tint: colour only, once a frame. */
const AREA_VISUAL: TriggerEntry = {
  status: "partial",
  note: "worked out once a step rather than once a frame; the screen-edge centres are not modelled",
};

const STATUS: ReadonlyMap<number, TriggerEntry> = new Map<number, TriggerEntry>([
  // --- enter effects, into the runtime's enter tables as they are reached ---
  [22, DONE],
  [1915, DONE],
  [23, ENTER_TIMED],
  [24, ENTER_TIMED],
  [25, ENTER_TIMED],
  [26, ENTER_TIMED],
  [27, ENTER_TIMED],
  [28, ENTER_TIMED],
  [55, { status: "partial", note: "the random angle is rolled once per object rather than at every latch" }],
  [56, ENTER_TIMED],
  [57, ENTER_TIMED],
  [58, ENTER_TIMED],
  [59, ENTER_TIMED],
  [32, TRAIL],
  [33, TRAIL],

  // --- colour ---
  [29, DONE],
  [30, DONE],
  [104, DONE],
  [105, DONE],
  [221, DONE],
  [717, DONE],
  [718, DONE],
  [743, DONE],
  [744, DONE],
  [899, DONE],
  [900, DONE],
  [915, DONE],
  [1006, DONE],
  [1007, DONE],
  [2903, { status: "partial", note: "drawn (render/gradients.ts): a layer per key 209, its sides from the main objects of keys 203-206 (or its corners, with key 207) and the view's edges, its colour running along the trigger's turn from key 21's channel to key 22's at their opacities and the trigger's group opacity, normal or additive (key 174 0 and 1), over its key-202 draw layer; 208 and 508 take layers away. Not drawn: blends 2 and 3, which multiply by and invert what is under them and need a blend state the sprite batch does not have. A screen-space layer (BG, MG, G, UI, Max) turns with the view, which the game's does not" }],
  [1520, DONE],
  [1585, { status: "partial", note: "starts the objects that wait for it (key 123) — their frame animation from frame 1 once the object is active (in the sections round the camera), and Custom Particles; with key 214 it passes over an object that is not active. The active range is the camera's from player 1 at a 16:9 width, centred on the player up and down; switching a beast to a named clip is not built" }],

  // --- scheduling ---
  [1049, DONE],
  [1268, DONE],
  [1616, { status: "partial", note: "stops, pauses or resumes what the triggers in its group started — moves, rotations, scales, follows, alphas, keyframes, pending spawns, pulses, touches and camera tweens — or what carries its control id; colour fades, counts, collisions and timers are not reached" }],
  [1812, DONE],
  [1912, DONE],
  [2068, DONE],
  [3607, { status: "partial", note: "steps its list in order; the stop and loop modes are not read" }],
  [3618, DONE],
  [1595, { status: "partial", note: "every press and release switches its group as its hold, mode, player and dual keys say, and Stop pauses or ends it; a dual touch does not yet keep player 2's presses from moving player 2" }],

  // --- movement ---
  [901, { status: "partial", note: "offset, target, direction, silent, dynamic aiming and the player/camera locks are in; the small-step option on key 393 is not" }],
  [1346, { status: "partial", note: "turns about a centre group and can aim at another group, live or once; the easing selector on key 403 is ignored" }],
  [2067, { status: "partial", note: "scales about a centre group; the game re-derives each object's own skew, which this does not" }],
  [1347, { status: "partial", note: "copies its main object's movement from any cause; the game measures that from a float copy of the position, so a follower of an object a float cannot place exactly creeps a little every step, which this does not" }],
  [1814, DONE],
  [3022, { status: "partial", note: "to its group's object as it stands now, with keep-x/y, gravity, the push along the exit and the camera keys (55, 464, 510); the force and dash redirects (keys 347-350, 591) are not built" }],
  [3033, { status: "partial", note: "runs the keyframes' path with their easing, curves, time modes, spins, scales, close loop and spawns, and the trigger's mods; a scale is not turned with a rotated group, and a newer rotation does not take over an older one's group" }],
  [3016, { status: "todo", note: "advanced follow is a separate solver, not the command machinery" }],
  [3660, { status: "todo", note: "edits an advanced-follow command, which does not exist yet" }],
  [3661, { status: "todo", note: "re-targets an advanced-follow command, which does not exist yet" }],
  [3006, AREA_MOTION],
  [3007, AREA_MOTION],
  [3008, AREA_MOTION],
  [3009, AREA_VISUAL],
  [3010, AREA_VISUAL],
  [3011, DONE],
  [3012, DONE],
  [3013, DONE],
  [3014, AREA_VISUAL],
  [3015, AREA_VISUAL],
  [3024, DONE],
  [3017, AREA],
  [3018, AREA],
  [3019, AREA],
  [3020, AREA],
  [3021, AREA],
  [3023, AREA],

  // --- items and counters ---
  [1611, DONE],
  [1811, DONE],
  [1817, DONE],
  [3619, { status: "partial", note: "items, points, the level time and the attempt are read and items, timers and points written; timers are stored but do not run (3614)" }],
  [3620, DONE],
  [3641, { status: "todo", note: "persistent items need the save file, which is goal 6" }],
  [1815, DONE],
  [3609, DONE],
  [3655, { status: "todo", note: "per-object control has no owner in this design yet" }],

  // --- camera ---
  [1913, DONE],
  [1914, DONE],
  [1916, DONE],
  [2015, DONE],
  [2062, DONE],
  [2016, { status: "unsupported", note: "an editor guide: it does nothing at runtime in the game either" }],
  [2925, { status: "partial", note: "free mode and the grid snap switch the corridor as a portal does, and the easing and padding shape the free follow of the modes other than the cube and robot; the corridor lock itself is the port's own approach rather than the game's eased static y, and the platformer camera is not built" }],
  [2900, {
    status: "partial",
    note: "turns the player, flips its gravity, reverses it and hands its forward speed over to the new axis, collides it against the level in its own frame, and switches the gameplay channel (keys 171-173) so a turned section fires along the way the player now travels; the camera follows along the new axis, and key 368 snaps its gameplay offset. The view itself is turned by Camera Rotate (2015), as in the game",
  }],
  [2901, { status: "todo", note: "moves the 75-unit gameplay offset, which the camera holds fixed" }],

  // --- gameplay ---
  [3600, { status: "partial", note: "ends the level where it is passed, touched or spawned, once; the one-second flight to the end point and the end effects are not drawn, the end screen comes at once" }],
  [1931, { status: "unsupported", note: "the old End trigger: the game's play layer ignores it in 2.206, its handler is empty" }],
  [1612, DONE],
  [1613, DONE],
  [1917, { status: "todo", note: "reverse gameplay needs the sim to run the player right-to-left" }],
  [1932, { status: "todo", note: "hands control to or from the player; the sim has no such switch yet" }],
  [1935, DONE],
  [2066, { status: "todo", note: "scales gravity for a group of players" }],
  [2899, { status: "partial", note: "all fourteen settings are read as the tri-states they are; the ones this build can act on are the ground, the two players and the controls" }],
  [3613, { status: "todo", note: "shows a UI element, which this build has none of" }],
  [3614, { status: "partial", note: "runs, stops at its target and spawns there; key 469 (ignore time warp) divides the warp back out, which the decompile does not show" }],
  [3615, DONE],
  [3617, DONE],
  [3604, { status: "partial", note: "listens for game events and spawns its group; the sim raises the landings (1-5), orb and pad events (7-9, 34-49), jumps and robot boosts (12-14, 19), coin and pickup (62, 63) and buttons (69-74), every event the tower floors use, but not the portal, gravity and other events" }],
  [3642, { status: "unsupported", note: "a beat guide for the editor; it has no effect while a level plays" }],
  [3662, { status: "partial", note: "copies one group's visibility onto another once, rather than tracking it" }],

  // --- scenery ---
  [3029, { status: "partial", note: "the new background is recorded; the art is not swapped mid-level yet" }],
  [3030, { status: "partial", note: "the new ground is recorded; the art is not swapped mid-level yet" }],
  [3031, { status: "partial", note: "the new middleground is recorded; the art is not swapped mid-level yet" }],
  [2999, DONE],
  [3606, DONE],
  [3612, DONE],
  [1818, { status: "todo", note: "the background effect layer is not built" }],
  [1819, { status: "todo", note: "the background effect layer is not built" }],

  // --- particles ---
  [2065, { status: "partial", note: "the emitter runs with the game's fades, friction, restarts and colour options, and follows its object's place, turn and scale as its position type says, and draws in its object's layer; a respawn starts every emitter over, where the game's side of that is not traced" }],
  [3608, { status: "partial", note: "spawns a one-shot copy of each Custom Particles object in its group at the position group, with the offsets, turn, scale and their variances; the variances use the renderer's random numbers, not the game's" }],

  // --- audio ---
  [1934, AUDIO],
  [3602, AUDIO],
  [3603, AUDIO],
  [3605, AUDIO],

  // --- screen effects ---
  [2904, DONE],
  [2905, SHADER_UNDRAWN],
  [2907, SHADER_UNDRAWN],
  [2909, SHADER_UNDRAWN],
  [2910, DONE],
  [2911, SHADER_UNDRAWN],
  [2912, SHADER_UNDRAWN],
  [2913, {
    status: "partial",
    note: "size, fade, strength, tint and centre are the game's; the centre does not turn with the camera, and a target the port cannot place (key 201, or a group with no single object) falls back to keys 290 and 291 where the game uses a fixed point",
  }],
  [2914, SHADER_UNDRAWN],
  [2915, SHADER_UNDRAWN],
  [2916, SHADER_UNDRAWN],
  [2917, SHADER_UNDRAWN],
  [2919, DONE],
  [2920, DONE],
  [2921, DONE],
  [2922, DONE],
  [2923, DONE],
  [2924, SHADER_UNDRAWN],
]);

const TODO: TriggerEntry = { status: "todo" };

export function statusOf(id: number): TriggerEntry {
  return STATUS.get(id) ?? TODO;
}

/** Every id this file has an opinion about, for the tests. */
export function declaredIds(): number[] {
  return [...STATUS.keys()];
}

export interface Coverage {
  /** Trigger ids the official levels place. */
  usedIds: number;
  /** Placements across the 27 official levels. */
  placements: number;
  byStatus: Record<TriggerStatus, { ids: number; placements: number }>;
  /** Unimplemented ids, heaviest first — the work queue. */
  worstGaps: { info: TriggerInfo; status: TriggerStatus }[];
  /** Levels every one of whose triggers is handled. */
  levelsFullyCovered: number[];
}

export function coverage(): Coverage {
  const byStatus: Coverage["byStatus"] = {
    done: { ids: 0, placements: 0 },
    partial: { ids: 0, placements: 0 },
    todo: { ids: 0, placements: 0 },
    unsupported: { ids: 0, placements: 0 },
  };
  const gaps: { info: TriggerInfo; status: TriggerStatus }[] = [];
  const levels = new Map<number, { total: number; open: number }>();
  let usedIds = 0;
  let placements = 0;

  for (const info of TRIGGER_CATALOGUE.values()) {
    if (info.uses === 0) continue;
    usedIds++;
    placements += info.uses;
    const { status } = statusOf(info.id);
    byStatus[status].ids++;
    byStatus[status].placements += info.uses;
    const open = status === "todo" || status === "partial";
    if (open) gaps.push({ info, status });
    for (const level of info.levels) {
      const at = levels.get(level) ?? { total: 0, open: 0 };
      at.total++;
      if (open) at.open++;
      levels.set(level, at);
    }
  }

  gaps.sort((a, b) => b.info.uses - a.info.uses);
  return {
    usedIds,
    placements,
    byStatus,
    worstGaps: gaps,
    levelsFullyCovered: [...levels]
      .filter(([, v]) => v.open === 0)
      .map(([id]) => id)
      .sort((a, b) => a - b),
  };
}
