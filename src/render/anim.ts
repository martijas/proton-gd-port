// Frame animations: which frames an animated object plays, on which of its
// sprites, and when — all three as the game decides them.
//
// What: the game's own table (assets/gameAnimations.ts, read out of
// GameManager::setupGameAnimations) gives each animated id a frame count, a
// frame time and two frame families, the main sprite's and the colour
// sprite's, `${name}_001.png` on.
//
// Which sprite: the frame families say it. A sprite resting on a frame of the
// main family plays the main frames, one on the colour family the colour
// frames; where the two families are one (1592), the colour slot decides. The
// few ids whose frames reach their sprites some other way — the wave strips'
// mirrored frames, the small coin's four sheets, 1592's colour playing back
// and forth, lava's three plays — are written out below by id.
// [EnhancedGameObject::updateSyncedAnimation, gd-ida-decomp.cpp:620683-621700:
//  the default path LABEL_303, the colour on the colour sprite's first child
//  LABEL_294 (gj22, fire), the wave strips :621205-621287, 1592 :621319-621339,
//  1614 :621568-621640, lava :621340-621440]
//
// When: updateSyncedAnimation is a function of the level time and a few numbers
// the object settles at load — its speed, keys 107, 122, 123, 126, 462 and
// 592 — with one piece of state, the freeze loops' pause. syncedFrame
// transcribes it. The start offsets customSetup and key 106 roll at load do
// not reach play: the reset before the first frame, and every restart and
// respawn, clears them (animTimingFor).
//
// Not transcribed: the per-id frame choices of 1697-1699 (a random frame each
// step), 1855 and 1858 (extra drop sprites), and the special animations of
// 1839-1842, 2892 and 2893. The first three play the plain cycle here; the
// last five hold their resting frame.

import type { LevelObject } from "../level/types";
import { GAME_ANIMATIONS, type GameAnimation } from "../assets/gameAnimations";
import { OBJECT_KEY, objectFlag, objectInt } from "../level/decode";
import { animFrame, type AnimEntity, type AnimPart } from "../assets/anims";

/** One frame a sprite shows, and whether it shows it mirrored (CCSprite::setFlipX). */
export interface AnimFrame {
  f: string;
  flip: boolean;
}

/** One of lava's plays: where its frames start in the book, how many, how long each. */
export interface LavaPlay {
  at: number;
  frames: number;
  time: number;
}

/** How an animated object's frames reach its sprites. */
export interface ObjectAnimation {
  /** Frames in the cycle (the generic path's +1196); for lava, its three plays end to end. */
  frames: number;
  /** Seconds a frame, before the object's own speed. */
  time: number;
  /** Lava's plays, or null for the generic cycle. */
  lava: readonly LavaPlay[] | null;
  /**
   * The frames a sprite plays, indexed by syncedFrame's result, from its
   * resting frame and whether it follows the detail colour; null for a sprite
   * that holds its frame.
   */
  framesFor(resting: string, detail: boolean): readonly AnimFrame[] | null;
}

/** Ids whose special animation is not transcribed: they hold their resting frame. [usesSpecialAnimation :621886-621895] */
const UNPORTED_SPECIAL: ReadonlySet<number> = new Set([1839, 1840, 1841, 1842, 2892, 2893]);
const LAVA_IDS: ReadonlySet<number> = new Set([1591, 1593]);
/** The animations lava plays, by its state: 1 is the surface, 2 and 3 the two bubbles. [:621381-621392] */
const LAVA_PLAYS = [2058, 2059, 2060] as const;

const FRAME_SUFFIX = /_\d{3}\.png$/;
const pad3 = (n: number): string => String(n).padStart(3, "0");

/** A frame's family: its name without the `_NNN.png`. */
function familyOf(frame: string): string {
  return frame.replace(FRAME_SUFFIX, "");
}

/**
 * The frames of one family as the table lays them out: `${stem}_001.png` to
 * `_${frames}`, with any custom frame spliced in where addCustomAnimationFrame
 * puts it — at its index when the list is that long, else on the end — and
 * then only the first `frames` kept, since the cycle never reaches the rest.
 * [addGameAnimation :622860-622885; addCustomAnimationFrame :622917-622960]
 */
function familyFrames(entry: GameAnimation, stem: string, custom: "main" | "color"): string[] {
  const list = Array.from({ length: entry.frames }, (_, i) => `${stem}_${pad3(i + 1)}.png`);
  for (const c of entry.custom ?? []) {
    const name = custom === "main" ? c.main : c.color;
    if (!name) continue;
    if (list.length >= c.at) list.splice(c.at - 1, 0, name);
    else list.push(name);
  }
  return list.slice(0, entry.frames);
}

/**
 * The wave strips (1050-1052, 3000-3002) have art for half their frames: the
 * rest show an earlier frame mirrored. [updateSyncedAnimation :621213-621287,
 *  setFlipX :621286]
 */
function waveRemap(id: number, frame: number): { frame: number; flip: boolean } {
  const first = id === 1050 || id === 3000;
  const map: Record<number, number> = first ? { 4: 3, 5: 2, 9: 8, 10: 7 } : { 7: 5, 8: 4, 9: 3, 10: 2 };
  const to = map[frame];
  return to === undefined ? { frame, flip: false } : { frame: to, flip: true };
}

/** The small coin's four frames are four sheets' first frames. [:621568-621640] */
const SMALL_COIN = 1614;

/**
 * Works out an animated object's frames. `exists` answers whether a frame
 * name is in the atlas: a family with a frame missing is not played, and
 * the sprites that would have played it hold still.
 */
export function objectAnimationFor(id: number, exists: (frame: string) => boolean): ObjectAnimation | null {
  if (UNPORTED_SPECIAL.has(id)) return null;
  const valid = (list: AnimFrame[] | null): AnimFrame[] | null => (list && list.every((a) => exists(a.f)) ? list : null);
  if (LAVA_IDS.has(id)) return lavaAnimation(valid);
  const entry = GAME_ANIMATIONS.get(id);
  if (!entry || entry.frames <= 1) return null;

  const plain = (stem: string, which: "main" | "color"): AnimFrame[] => familyFrames(entry, stem, which).map((f) => ({ f, flip: false }));
  let main: AnimFrame[] | null = plain(entry.name, "main");
  let colour: AnimFrame[] | null = entry.color ? plain(entry.color, "color") : null;
  const byResting = new Map<string, AnimFrame[] | null>();

  if ((id >= 1050 && id <= 1052) || (id >= 3000 && id <= 3002)) {
    const remap = (stem: string): AnimFrame[] =>
      Array.from({ length: entry.frames }, (_, i) => {
        const r = waveRemap(id, i + 1);
        return { f: `${stem}_${pad3(r.frame)}.png`, flip: r.flip };
      });
    main = remap(entry.name);
    if (entry.color) colour = remap(entry.color);
  } else if (id === 1592) {
    // The colour plays 1, 8, 7 … 2 against the main's 1 … 8. [:621319-621339]
    colour = Array.from({ length: entry.frames }, (_, i) => {
      const k = i + 1;
      return { f: `${entry.color}_${pad3(k > 1 ? 10 - k : k)}.png`, flip: false };
    });
  } else if (id === SMALL_COIN) {
    const sheet = (suffix: string): AnimFrame[] =>
      Array.from({ length: entry.frames }, (_, i) => ({ f: `smallCoin_${pad3(i + 1).slice(1)}${suffix}_001.png`, flip: false }));
    byResting.set("smallCoin_01_001.png", valid(sheet("")));
    byResting.set("smallCoin_01_color_001.png", valid(sheet("_color")));
    byResting.set("smallCoin_01_highlight_001.png", valid(sheet("_highlight")));
    main = null;
    colour = null;
  }
  main = valid(main);
  colour = valid(colour);
  const name = entry.name;
  const color = entry.color;
  return {
    frames: entry.frames,
    time: entry.time,
    lava: null,
    framesFor(resting: string, detail: boolean): readonly AnimFrame[] | null {
      if (byResting.has(resting)) return byResting.get(resting) ?? null;
      const family = familyOf(resting);
      if (family === name && family === color) return detail ? colour : main;
      if (family === name) return main;
      if (color !== null && family === color) return colour;
      return null;
    },
  };
}

/**
 * Lava (1591, 1593) plays whole animations of its own: the surface, and for
 * 1591 now and then one of two bubbles. Its book is the three end to end.
 * The frame times are the table's for those three ids — the game reads them
 * from a constant block (unk_983F2C) the decompile does not show, and the
 * table's are the ones it has for the same art. [inferred]
 */
function lavaAnimation(valid: (list: AnimFrame[] | null) => AnimFrame[] | null): ObjectAnimation | null {
  const plays: LavaPlay[] = [];
  const main: AnimFrame[] = [];
  const colour: AnimFrame[] = [];
  for (const id of LAVA_PLAYS) {
    const entry = GAME_ANIMATIONS.get(id);
    if (!entry || !entry.color) return null;
    plays.push({ at: main.length, frames: entry.frames, time: entry.time });
    for (const f of familyFrames(entry, entry.name, "main")) main.push({ f, flip: false });
    for (const f of familyFrames(entry, entry.color, "color")) colour.push({ f, flip: false });
  }
  const mainBook = valid(main);
  const colourBook = valid(colour);
  if (!mainBook) return null;
  return {
    frames: main.length,
    time: plays[0].time,
    lava: plays,
    framesFor(resting: string): readonly AnimFrame[] | null {
      const family = familyOf(resting);
      if (family === "lava_top") return mainBook;
      if (family === "lava_top_color") return colourBook;
      return null;
    },
  };
}

// --- timing ------------------------------------------------------------------

/** The numbers updateSyncedAnimation reads, settled once per object. */
export interface AnimTiming {
  /** Frames in the cycle. */
  frames: number;
  /** Seconds a frame after the object's speed, as the float the game divides by (+1192). */
  interval: number;
  /** Plays last frame first (+1228 with a negative +1224). */
  reverse: boolean;
  /** Seconds added to the level time (+1164): 0 in play, see animTimingFor. */
  startOffset: number;
  /** Key 462 (+1232) and key 592 (+1236). */
  single: number;
  offsetAnim: boolean;
  /** Key 123 (+1229): hidden until an Animate trigger, then one play. */
  onTrigger: boolean;
  /** A freeze loop (+1188): a blank slot after the last frame, and a pause in it. */
  freeze: boolean;
  /** 1855 shows its last frame through the pause rather than nothing (+1189). */
  keepFrozenFrame: boolean;
  /**
   * The first frame count that lands on the blank slot, or -1 for none: where
   * a play on a trigger ends and a freeze loop first pauses. Settled with the
   * rest, so syncedFrame need not look for it every frame.
   */
  firstBlank: number;
  /** Lava's plays, or null. */
  lava: readonly LavaPlay[] | null;
  /** 1593's lava plays its surface for ever; 1591 rolls a new play after each. */
  lavaLoops: boolean;
  /** 1591's first play is rolled too, as in play; the editor's starts on the surface. */
  lavaRollsFirst: boolean;
  /** What stands in for the game's rand(): the object's place in the level string. */
  seed: number;
}

/**
 * Freeze loops: after the last frame a blank slot, in which the object hides
 * for a random 0.2-0.7 s before the next loop.
 * [GameObject::usesFreezeAnimation :621821-621880]
 */
export function usesFreezeAnimation(id: number): boolean {
  if (id === 921 || id === 1519 || id === 1618 || id === 1851 || id === 1852 || id === 1860 || id === 2033) return true;
  if (id >= 1854 && id <= 1856) return true;
  if (id >= 2020 && id <= 2022) return true;
  if (id >= 2024 && id <= 2031) return true;
  if (id >= 2035 && id <= 2040) return true;
  if (id >= 2043 && id <= 2055) return true;
  if (id >= 2867 && id <= 2872) return true;
  if (id >= 2875 && id <= 2878) return true;
  return id === 2880 || id === 2882 || id === 2883 || (id >= 2885 && id <= 2887);
}

/** The fire, smoke and drop set that customSetup gives a random speed and a 70 % start roll. [LABEL_137/138 :182231-182250] */
function firesAndDrops(id: number): boolean {
  return (
    id === 920 || id === 921 || id === 923 || id === 924 || id === 1518 || id === 1519 ||
    (id >= 1936 && id <= 1939) || (id >= 1849 && id <= 1858) || id === 1860
  );
}

/** The 2.2 animated set. [LABEL_145 :182423-182441] */
function gj22(id: number): boolean {
  return (id >= 2020 && id <= 2055) || id === 2864 || id === 2865 || (id >= 2867 && id <= 2894);
}

/** The pixel-art set; all but 2605 and 2694 take a random speed. [LABEL_118 :182458-182468] */
const PIXEL_ART: ReadonlySet<number> = new Set([
  2223, 2246, 2605, 2629, 2630, 2694, 3119, 3120, 3121, 3219, 3303, 3304, 3482, 3483, 3484, 3492, 3493, 4211, 4300,
]);

/**
 * The speed customSetup rolls for an object (+1184), which divides its frame
 * time unless keys 122 and 107 set their own. 1.0 unless rolled.
 * [EnhancedGameObject::customSetup :181863-182790; ctor :303512]
 */
function rolledSpeed(id: number, seed: number): number {
  const r = hash01(seed, 0x5eed);
  if (id >= 1697 && id <= 1699) return 0.8 + r * 0.5;
  if (firesAndDrops(id) || gj22(id) || id === 1583 || id === 1618 || LAVA_IDS.has(id)) return 0.8 + r * 0.4;
  if (PIXEL_ART.has(id) && id !== 2605 && id !== 2694) return 0.8 + r * 0.4;
  return 1;
}

/**
 * The start offset an object with key 106 (+1220) loads with. customSetup
 * presets one for some ids — half a second at most, and for the fire and 2.2
 * sets only seven times in ten, the other three blocked from any (+1180) —
 * and saveActiveColors rolls up to a second for the rest. Without key 106
 * there is none: saveActiveColors clears it. Only the editor ever sees it:
 * play resets every object before its first frame. [customSetup LABEL_138,
 *  :182423-182441, :182672-182700; EnhancedGameObject::saveActiveColors
 *  :173339-173351]
 */
function loadedStartOffset(id: number, randomStart: boolean, seed: number): number {
  if (!randomStart) return 0;
  const roll = hash01(seed, 0x57a7);
  const r = hash01(seed, 0x0ff5);
  if (firesAndDrops(id) || gj22(id) || id === 1583) return roll <= 0.7 ? r * 0.5 : 0;
  if (LAVA_IDS.has(id) || id === 1618 || (id >= 1697 && id <= 1699)) return r * 0.5;
  return r;
}

/**
 * Everything updateSyncedAnimation needs from an object, from its keys and
 * the rolls customSetup makes for its id.
 *
 * In play the start offset is 0 and lava's first play is rolled like the
 * rest: PlayLayer::resetLevel resets every object before the first frame,
 * and on every restart and respawn, which clears what customSetup and
 * saveActiveColors set at load. So every copy of an animation runs in step,
 * and only the rolled speeds tell them apart. `editor` keeps the load's
 * values, for a view that never resets. [EnhancedGameObject::
 *  customObjectSetup :181800-181840; setupAnimationVariables :624745-624780;
 *  PlayLayer::setupHasCompleted :106465 → resetLevel :105839-105843 →
 *  EnhancedGameObject::resetObject :170043-170067 (+1164 and +1240 to 0);
 *  customSetup's lava preset :182709-182710]
 */
export function animTimingFor(object: LevelObject, animation: ObjectAnimation, editor = false): AnimTiming {
  const id = object.id;
  const seed = object.index;
  const useSpeed = objectFlag(object, OBJECT_KEY.useSpeed);
  const speedKey = Number.parseFloat(object.props[OBJECT_KEY.animSpeed] ?? "0") || 0;
  const divisor = useSpeed && speedKey !== 0 ? Math.abs(speedKey) : rolledSpeed(id, seed);
  const timing: AnimTiming = {
    frames: animation.frames,
    interval: Math.fround(Math.fround(animation.time) / Math.fround(divisor)),
    reverse: useSpeed && speedKey < 0,
    startOffset: editor ? Math.fround(loadedStartOffset(id, objectFlag(object, OBJECT_KEY.randomStart), seed)) : 0,
    single: objectInt(object, OBJECT_KEY.singleFrame),
    offsetAnim: objectFlag(object, OBJECT_KEY.offsetAnim),
    onTrigger: objectFlag(object, OBJECT_KEY.animateOnTrigger),
    freeze: usesFreezeAnimation(id) && !objectFlag(object, OBJECT_KEY.noDelayedLoop),
    keepFrozenFrame: id === 1855,
    firstBlank: -1,
    lava: animation.lava,
    lavaLoops: id === 1593,
    lavaRollsFirst: !editor,
    seed,
  };
  const slots = slotCount(timing);
  for (let k = 0; slots > timing.frames && k < slots; k++) {
    if (slotAt(timing, slots, k) === slots) {
      timing.firstBlank = k;
      break;
    }
  }
  return timing;
}

/** The cycle's length in slots: one more than the frames for a freeze loop or a play on a trigger. */
function slotCount(s: AnimTiming): number {
  return s.freeze || s.onTrigger ? s.frames + 1 : s.frames;
}

/** Whole frame times in `w` seconds, never below 0 (v16). */
function frameCount(s: AnimTiming, w: number): number {
  const k = Math.floor(Math.fround(Math.fround(w) / s.interval));
  return k > 0 ? k : 0;
}

/** v19: the slot a frame count lands on, 1-based; `slots` is the blank one. */
function slotAt(s: AnimTiming, slots: number, k: number): number {
  let kk = k;
  if (s.single > 0) {
    if (s.offsetAnim) kk += s.single;
    else if (!s.onTrigger) kk = s.single - 1;
  }
  const r = kk % slots;
  return s.reverse ? slots - r : r + 1;
}

/** The frame a slot shows: the last one for the blank slot, which the caller hides. */
function frameOfSlot(s: AnimTiming, slots: number, slot: number): number {
  return slot === slots && slots > s.frames ? s.frames - 1 : slot - 1;
}

/** A fresh cache for syncedFrame: where the last call's loop walk got to. */
export function animMemo(): Float64Array {
  return new Float64Array(3).fill(Number.NaN);
}

/**
 * The frame an animated object shows at level time `t`, as an index into its
 * sprites' frame lists, or -1 while it is hidden. `triggeredAt` is the level
 * time of the last Animate trigger to reach it, NaN for none. `memo` (from
 * animMemo) lets a caller that asks every frame resume the freeze pauses and
 * lava's plays where it left off instead of walking them from the start.
 *
 * The generic path: the time plus the start offset, in frame times, taken
 * modulo the cycle — which is one slot longer for a freeze loop or an object
 * waiting on a trigger. That extra slot shows nothing: a freeze loop pauses
 * in it for 0.2-0.7 s and goes on, an object on a trigger hides in it until
 * the next one. Key 462 pins one frame, or with 592 shifts the cycle by it.
 * [EnhancedGameObject::updateSyncedAnimation :620683-620770, the freeze and
 *  trigger tail LABEL_310 :621165-621186; triggerAnimation :620430-620445;
 *  waitForAnimationTrigger :620462-620475]
 */
export function syncedFrame(s: AnimTiming, t: number, triggeredAt = Number.NaN, memo?: Float64Array): number {
  if (s.lava) return lavaFrame(s, s.lava, t + s.startOffset, memo);
  let u: number;
  if (s.onTrigger) {
    // Waiting from the start, and again after each play; a trigger starts the
    // clock from itself.
    if (!(triggeredAt <= t)) return -1;
    u = t - triggeredAt;
  } else {
    u = t + s.startOffset;
  }
  const n = s.frames;
  const slots = slotCount(s);
  const first = s.firstBlank;

  if (s.onTrigger) {
    // One play: hidden from the first blank slot on.
    const k = frameCount(s, u);
    if (first >= 0 && first <= k) return -1;
    return frameOfSlot(s, slots, slotAt(s, slots, k));
  }
  if (!s.freeze || first < 0) return frameOfSlot(s, slots, slotAt(s, slots, frameCount(s, u)));

  // A freeze loop. The blank slots come every `slots` counts from the first;
  // at each the clock stops for that loop's pause, then runs on through the
  // rest of the blank slot and into the next loop.
  const hidden = s.keepFrozenFrame ? n - 1 : -1;
  if (s.single > 0 && !s.offsetAnim) return hidden; // pinned to the blank slot: it pauses once and never moves again
  let j = 0;
  let paused = 0;
  if (memo && Number.isFinite(memo[0]) && u >= memo[2]) {
    j = memo[0];
    paused = memo[1];
  }
  for (;;) {
    const clock = (first + j * slots) * s.interval;
    const pauseAt = clock + paused;
    if (u < pauseAt) break;
    const pause = 0.2 + 0.5 * hash01(s.seed, j + 1);
    if (u < pauseAt + pause) return hidden;
    paused += pause;
    j++;
    if (memo) {
      memo[0] = j;
      memo[1] = paused;
      memo[2] = pauseAt + pause;
    }
  }
  const slot = slotAt(s, slots, frameCount(s, u - paused));
  return slot === slots ? hidden : frameOfSlot(s, slots, slot);
}

/**
 * Lava's plays: for 1591 a roll before each — a bubble three times in ten,
 * the other bubble three times in ten of the rest, else the surface — each
 * play timed from its own start. 1593 plays its surface round and round.
 * [updateSyncedAnimation LABEL_165-LABEL_175 :621340-621455]
 */
function lavaFrame(s: AnimTiming, plays: readonly LavaPlay[], u: number, memo?: Float64Array): number {
  if (s.lavaLoops) return lavaPlayFrame(plays[0], u);
  let c = 0;
  let start = 0;
  if (memo && Number.isFinite(memo[0]) && u >= memo[1]) {
    c = memo[0];
    start = memo[1];
  }
  for (;;) {
    const play = plays[lavaState(s.seed, c, s.lavaRollsFirst) - 1];
    const end = start + play.frames * play.time;
    if (u < end) return lavaPlayFrame(play, u - start);
    c++;
    start = end;
    if (memo) {
      memo[0] = c;
      memo[1] = start;
    }
  }
}

/** The frame `w` seconds into one of lava's plays, as an index into its book. */
function lavaPlayFrame(play: LavaPlay, w: number): number {
  const k = Math.floor(Math.fround(Math.fround(w) / Math.fround(play.time)));
  return play.at + ((k > 0 ? k : 0) % play.frames);
}

/**
 * Which of lava's plays cycle `c` is, rolled; the editor's first is the
 * surface customSetup presets (+1240 = 1), which play's reset clears.
 */
function lavaState(seed: number, c: number, rollsFirst: boolean): number {
  if (c === 0 && !rollsFirst) return 1;
  if (hash01(seed, c * 2 + 0x1a) > 0.7) return 2;
  if (hash01(seed, c * 2 + 0x1b) > 0.7) return 3;
  return 1;
}

/**
 * The recolour flash of 2046, 2047 and 2055 on their first frames, unless key
 * 127 turns it off: which halves go white at frame `index`. 1 is the main,
 * 2 the detail. The colour is a constant the decompile does not show
 * (unk_983F3B), read here as white. [SpecialAnimGameObject::
 *  updateSyncedAnimation :621698-621740; customObjectSetup :298351-298361]
 */
export function flashHalves(object: LevelObject, index: number): number {
  if (index < 0) return 0;
  const id = object.id;
  if (id !== 2046 && id !== 2047 && id !== 2055) return 0;
  if (objectFlag(object, OBJECT_KEY.disableAnimShine)) return 0;
  switch (id) {
    case 2047:
      return index === 0 ? 3 : 0;
    case 2055:
      return index === 0 ? 1 : 0;
    default:
      return index === 0 || index > 2 ? 2 : 0;
  }
}

/** A stable 0..1 for (seed, salt): what stands in for one of the game's rand() rolls. */
export function hash01(seed: number, salt: number): number {
  let h = Math.imul(seed + 1, 2654435761) ^ Math.imul(salt + 0x9e37, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Picks one of `choices` for an object, by its position in the level string, so
 * the same level always looks the same and a restart changes nothing.
 *
 * The game rolls a real die here; a level that looked different on every
 * attempt would make a saved macro's screenshots meaningless, and the object
 * this applies to is a decorative spike variant (id 9, 3,845 placements in the
 * official levels), so nothing depends on it being random.
 */
export function randomFrameFor(choices: readonly string[], objectIndex: number): string {
  // A small integer hash: consecutive objects must not walk the list in order,
  // or a row of spikes comes out as a repeating pattern.
  let h = (objectIndex + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return choices[(h >>> 0) % choices.length];
}

// --- skeletal entities -------------------------------------------------------

/**
 * A level's beasts are the same kind of thing as the robot and the spider: a
 * handful of limb textures moved about by a per-frame transform. Unlike the
 * player's, their textures are ordinary atlas frames, so a limb is an ordinary
 * sprite and the whole entity is a fixed set of sprites whose transform and
 * frame change together.
 *
 * `slots` is that fixed set. A slot is one limb, identified by the part tag the
 * animation gives it, and carries what that limb looks like in every frame —
 * or null for the frames it is not in, because the part list is not the same
 * from frame to frame (GJBeast04 alternates between four limbs and three).
 */
export interface SkeletonSlot {
  tag: number;
  /** Draw order inside the entity, low first. */
  z: number;
  /** One entry per frame of the clip; null where the limb is absent. */
  frames: (AnimPart | null)[];
}

/** One clip of a plan: its frames are `start` to `start + frames - 1` of every slot. */
export interface SkeletonClip {
  name: string;
  start: number;
  frames: number;
  /** Seconds per frame. */
  interval: number;
  looped: boolean;
}

export interface SkeletonPlan {
  /** The clips the object can play, the one it starts on first. */
  clips: SkeletonClip[];
  /** Every clip's frames, end to end. */
  frames: number;
  slots: SkeletonSlot[];
  /** The object, whose id picks the clip after one that ends (nextSkeletonClip). */
  objectId: number;
}

/**
 * The clip an animated object plays after one that is not looped ends, given
 * one of the game's rand() rolls (0..1): the beasts go back to idle01, now
 * and then to idle02, the bat (918) to its bite, and an attack's or a
 * sleep's opening to its loop. An object with no rule, or a clip of its
 * entity's the rule does not name, stops on its last frame (null).
 * [gdp AnimatedGameObject::animationFinished :302092-302280]
 */
export function nextSkeletonClip(objectId: number, finished: string, roll: number): string | null {
  const idle = (p: number): string => (finished === "idle01" && roll > p ? "idle02" : "idle01");
  switch (objectId) {
    case 918:
      return finished === "attack01" ? "attack01_loop" : "bite";
    case 1327:
      return idle(0.75);
    case 1328:
      return idle(0.9);
    case 1584:
      if (finished === "attack02") return "attack02_loop";
      if (finished === "sleep") return "sleep_loop";
      return idle(0.8);
    case 2012:
      if (finished === "toAttack03") return "attack03";
      if (finished === "fromAttack03" || finished === "attack02" || finished === "toAttack01") return "attack01";
      return idle(0.75);
    default:
      return null;
  }
}

/**
 * Which clip an entity starts on: its definition's defaultAnimation, else
 * its first clip. [gdp CCAnimatedSprite::loadType :30404-30407 (+536);
 * AnimatedGameObject::updateObjectAnimation :307180-307186]
 */
function startingClip(entity: AnimEntity): string | null {
  const start = entity.defaultAnimation;
  if (start && entity.animations[start]) return start;
  return Object.keys(entity.animations)[0] ?? null;
}

export function skeletonFor(entity: AnimEntity, objectId = 0): SkeletonPlan | null {
  const first = startingClip(entity);
  if (!first) return null;
  // The starting clip and every clip the chain can reach from it.
  const names = [first];
  for (let i = 0; i < names.length; i++) {
    const clip = entity.animations[names[i]];
    if (clip.looped) continue;
    for (const roll of [0, 1]) {
      const next = nextSkeletonClip(objectId, names[i], roll);
      if (next && entity.animations[next] && !names.includes(next)) names.push(next);
    }
  }
  const clips: SkeletonClip[] = [];
  const perFrame: AnimPart[][] = [];
  for (const name of names) {
    const anim = entity.animations[name];
    const count = Math.max(1, anim.frames);
    clips.push({ name, start: perFrame.length, frames: count, interval: anim.delay > 0 ? anim.delay : 0.06, looped: anim.looped !== 0 });
    for (let k = 0; k < count; k++) perFrame.push(animFrame(entity, name, k) ?? []);
  }
  const count = perFrame.length;
  if (perFrame.every((parts) => parts.length === 0)) return null;

  // Slots are keyed by part tag so a limb keeps its sprite across frames even
  // when the list it appears in is a different length.
  const order: number[] = [];
  const byTag = new Map<number, SkeletonSlot>();
  for (const parts of perFrame) {
    for (const part of parts) {
      if (byTag.has(part.tag)) continue;
      byTag.set(part.tag, { tag: part.tag, z: part.z, frames: new Array<AnimPart | null>(count).fill(null) });
      order.push(part.tag);
    }
  }
  for (let k = 0; k < count; k++) {
    for (const part of perFrame[k]) {
      const slot = byTag.get(part.tag);
      if (slot) slot.frames[k] = part;
    }
  }
  const slots = order.map((tag) => byTag.get(tag)!).sort((a, b) => a.z - b.z);
  return { clips, frames: count, slots, objectId };
}

/** Where a skeletal object is in its plan: the clip, when it began, and how many rolls it has made. */
export interface SkeletonClock {
  clip: number;
  began: number;
  rolls: number;
}

/**
 * Starts an object on its first clip, part-way through by one roll, as the
 * game does each time the object becomes active. [gdp AnimatedGameObject::
 * activateObject :307207-307219 → updateObjectAnimation :307180-307186
 * (offsetCurrentAnimation by rand() / 2^31)]
 */
export function startSkeleton(plan: SkeletonPlan, clock: SkeletonClock, seconds: number, seed: number): void {
  const clip = plan.clips[0];
  clock.clip = 0;
  clock.began = seconds - hash01(seed, clock.rolls++) * clip.frames * clip.interval;
}

/**
 * The plan frame an object shows at `seconds`, moving it on to the next clip
 * each time a clip that is not looped ends. One with no next clip holds its
 * last frame.
 */
export function skeletonFrame(plan: SkeletonPlan, clock: SkeletonClock, seconds: number, seed: number): number {
  for (let guard = 0; guard < 64; guard++) {
    const clip = plan.clips[clock.clip];
    const k = Math.floor((seconds - clock.began) / clip.interval);
    if (clip.looped) return clip.start + (((k % clip.frames) + clip.frames) % clip.frames);
    if (k < clip.frames) return clip.start + Math.max(0, k);
    const next = nextSkeletonClip(plan.objectId, clip.name, hash01(seed, clock.rolls++));
    const at = next === null ? -1 : plan.clips.findIndex((c) => c.name === next);
    if (at < 0) return clip.start + clip.frames - 1;
    clock.began += clip.frames * clip.interval;
    clock.clip = at;
  }
  // Far behind (a long jump in the clock): pick the chain up from here.
  clock.began = seconds;
  return plan.clips[clock.clip].start;
}

/**
 * Which of a beast's limbs take the object's detail colour; every other limb
 * takes its main colour (key 21, black by default), which the whole animated
 * sprite is set to first. The game makes one limb the object's colour sprite,
 * which setChildColor tints with the detail colour (key 22, white by default):
 * the limb at that index of the animation's texture list, `texture_N` in the
 * file, whose own tag the frames then name it by. GJBeast05 has a second one
 * (+1276) that AnimatedGameObject::setChildColor tints the same way. GJBeast01
 * has none of its own: its colour sprite is an extra sprite, GJBeast01_03,
 * added on top of limb 1 at its centre. The Black Sludge has none, so it is
 * all main colour.
 * [gdp AnimatedGameObject::setupChildSprites :306803-307100 (+748 = limb 0 for
 *  1327, 1328 and 1584, limb 1 for 2012 with +1276 = limb 2; 918's
 *  addCustomColorChild on limb 1 at z 1 :307071-307086); CCPartAnimSprite::
 *  initWithAnimDesc :36476ff (the limb list in texture_N order); setObjectColor
 *  :297856-297860; GameObject::setChildColor :163746-163771;
 *  AnimatedGameObject::setChildColor :297934-297947]
 */
const ENTITY_DETAIL_LIMBS: ReadonlyMap<number, readonly number[]> = new Map([
  [1327, [0]],
  [1328, [0]],
  [1584, [0]],
  [2012, [1, 2]],
]);
const ENTITY_DETAIL_CHILD: ReadonlyMap<number, { limb: number; tex: string }> = new Map([
  [918, { limb: 1, tex: "GJBeast01_03_001.png" }],
]);

export interface EntityColours {
  /** Part tags of the limbs that take the detail colour. */
  detailTags: ReadonlySet<number>;
  /** An extra detail-coloured sprite drawn on a limb, centred on it, just above it. */
  child: { tag: number; tex: string } | null;
}

export function entityColours(objectId: number, entity: AnimEntity): EntityColours {
  const tagOf = (limb: number): number | null => entity.textures[limb]?.tag ?? null;
  const detailTags = new Set<number>();
  for (const limb of ENTITY_DETAIL_LIMBS.get(objectId) ?? []) {
    const tag = tagOf(limb);
    if (tag !== null) detailTags.add(tag);
  }
  const extra = ENTITY_DETAIL_CHILD.get(objectId);
  const tag = extra ? tagOf(extra.limb) : null;
  return { detailTags, child: extra && tag !== null ? { tag, tex: extra.tex } : null };
}
