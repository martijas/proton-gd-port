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
/** The audio triggers. Reverb is a convolution of FMOD's preset numbers. */
const AUDIO: TriggerEntry = {
  status: "done",
  note: "channels, preps, edits, proximity, checkpoint replay and reverb (407/502/503); the reverb convolves FMOD's preset numbers rather than running FMOD's SFXREVERB",
};
/** The Ghost Trail: the fading copies of the icon render/ghostTrail.ts draws behind the player, which these start and stop. */
const TRAIL: TriggerEntry = { status: "done", note: "fading copies of the icon follow the player while it is on" };
/**
 * Distortion shaders whose centres turn with Camera Rotate about the screen
 * middle. Values, easing, follow/invert and the band are the game's.
 */
const SHADER_CENTRE: TriggerEntry = {
  status: "done",
  note: "drawn through the game's shader; follow and fixed centres turn with the camera; a target the port cannot place falls back to keys 290 and 291",
};
const AREA: TriggerEntry = { status: "todo", note: "the area triggers pick their objects at fire time; not built" };
/** Area Move, Rotate and Scale: worked out every step from each object's distance to the centre. */
const AREA_MOTION: TriggerEntry = {
  status: "partial",
  note: "falloff, easing, dual easing, variance, priority, the players or a group as centre, and the screen-edge centres are the game's; group parents are not moved as one piece, and the variance table's seed is not the game's",
};
/** Area Fade and Tint: colour only, once a frame. */
const AREA_VISUAL: TriggerEntry = {
  status: "partial",
  note: "worked out once a frame with the screen-edge centres; group parents are not faded or tinted as one piece, and the variance table's seed is not the game's",
};
/** Enter Fade / Enter Tint: custom enter effects on a channel's list. */
const ENTER_CUSTOM: TriggerEntry = {
  status: "done",
  note: "length, offset, dead zone, easing and the enter channel, as applyCustomEnterEffect; Move/Rotate/Scale (3017-3019) are not drawn",
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
  [2903, { status: "partial", note: "drawn (render/gradients.ts): a layer per key 209, its sides from the main objects of keys 203-206 (or its corners, with key 207) and the view's edges, its colour running along the trigger's turn from key 21's channel to key 22's at their opacities and the trigger's group opacity, normal / additive / multiply / invert (key 174 0-3), over its key-202 draw layer; 208 and 508 take layers away. Screen-space layers (BG, MG, G, UI, Max) stay upright under Camera Rotate" }],
  [1520, DONE],
  [1585, DONE],

  // --- scheduling ---
  [1049, DONE],
  [1268, DONE],
  [1616, DONE],
  [1812, DONE],
  [1912, DONE],
  [2068, DONE],
  [3607, DONE],
  [3618, DONE],
  [1595, { status: "partial", note: "every press and release switches its group as its hold, mode, player and dual keys say, and Stop pauses or ends it; a dual touch does not yet keep player 2's presses from moving player 2" }],

  // --- movement ---
  [901, DONE],
  [1346, DONE],
  [2067, DONE],
  [1347, DONE],
  [1814, DONE],
  [3022, DONE],
  [3033, DONE],
  [3016, {
    status: "partial",
    note: "modes 0–2 per-object velocity steering with delayed position history and enter-effect group-copy passes; enter-effect copies themselves are only moved when the runtime has registered them",
  }],
  [3660, DONE],
  [3661, DONE],
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
  [3020, ENTER_CUSTOM],
  [3021, ENTER_CUSTOM],
  [3023, AREA],

  // --- items and counters ---
  [1611, DONE],
  [1811, DONE],
  [1817, DONE],
  [3619, { status: "partial", note: "items, points, the level time and the attempt are read and items, timers and points written; timers are stored but do not run (3614)" }],
  [3620, DONE],
  [3641, DONE],
  [1815, DONE],
  [3609, DONE],
  [3655, { status: "unsupported", note: "the game's activateObjectControlTrigger is empty in 2.206; the editor popup only offers a Target ID" }],

  // --- camera ---
  [1913, DONE],
  [1914, DONE],
  [1916, DONE],
  [2015, DONE],
  [2062, DONE],
  [2016, { status: "unsupported", note: "an editor guide: it does nothing at runtime in the game either" }],
  [2925, { status: "partial", note: "free mode and the grid snap switch the corridor as a portal does, and the easing and padding shape the free follow of the modes other than the cube and robot; the corridor lock itself is the port's own approach rather than the game's eased static y; a platformer's dead zone (55/27.5) and travel divisor (8) are built" }],
  [2900, {
    status: "partial",
    note: "turns the player, flips its gravity, reverses it and hands its forward speed over to the new axis, collides it against the level in its own frame, and switches the gameplay channel (keys 171-173) so a turned section fires along the way the player now travels; the camera follows along the new axis, and key 368 snaps its gameplay offset. The view itself is turned by Camera Rotate (2015), as in the game",
  }],
  [2901, DONE],

  // --- gameplay ---
  [3600, DONE],
  [1931, { status: "unsupported", note: "the old End trigger: the game's play layer ignores it in 2.206, its handler is empty" }],
  [1612, DONE],
  [1613, DONE],
  [1917, DONE],
  [1932, DONE],
  [1935, DONE],
  [2066, DONE],
  [2899, DONE],
  [3613, { status: "partial", note: "layout at load and on mid-level re-fire pins the target group to the screen about the UI target with X/Y ref and aspect scale (positionUIObjects); the objects stay in the world draw list with a per-frame screen offset rather than a separate UI layer / section removal" }],
  [3614, { status: "partial", note: "runs, stops at its target and spawns there; key 469 (ignore time warp) divides the warp back out, which the decompile does not show" }],
  [3615, DONE],
  [3617, DONE],
  [3604, { status: "partial", note: "listens for game events and spawns its group; the sim raises landings, hit-head, orbs, pads, jumps, robot boosts, UFO jump, spider teleport, swing/wave/dash, fall distance and fall speed, gravity inverted/restored, mode/gravity/mirror/scale/dual/teleport portals, teleported, coin, pickup, checkpoint, checkpoint respawn and buttons; ship boost start/end are named in gameEventToString but never raised in the decompile" }],
  [3642, { status: "unsupported", note: "a beat guide for the editor; it has no effect while a level plays" }],
  [3662, { status: "partial", note: "copies one group's visibility onto another once, rather than tracking it" }],

  // --- scenery ---
  [3029, DONE],
  [3030, DONE],
  [3031, DONE],
  [2999, DONE],
  [3606, DONE],
  [3612, DONE],
  [1818, DONE],
  [1819, DONE],

  // --- particles ---
  [2065, DONE],
  [3608, DONE],

  // --- audio ---
  [1934, AUDIO],
  [3602, AUDIO],
  [3603, AUDIO],
  [3605, AUDIO],

  // --- screen effects ---
  [2904, DONE],
  [2905, SHADER_CENTRE],
  [2907, SHADER_CENTRE],
  [2909, DONE],
  [2910, DONE],
  [2911, DONE],
  [2912, DONE],
  [2913, SHADER_CENTRE],
  [2914, SHADER_CENTRE],
  [2915, DONE],
  [2916, SHADER_CENTRE],
  [2917, SHADER_CENTRE],
  [2919, DONE],
  [2920, DONE],
  [2921, DONE],
  [2922, DONE],
  [2923, DONE],
  [2924, DONE],
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
