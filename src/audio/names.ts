// Which file a sound is, and which sounds the game does not have.
//
// The second half matters as much as the first. Geometry Dash is much quieter
// than people remember: a cube jumping makes no sound, an orb makes no sound,
// a pad makes no sound, landing makes no sound, and picking up a coin makes
// none either. Only death, the level ending and the level's own audio
// triggers do. So every simulation event is listed below, including the
// silent ones, with a reason — the same rule src/triggers/registry.ts follows,
// so a missing sound is a decision on the record rather than something nobody
// got round to.

import type { SimEvent } from "../physics/types";

/** A sound in assets/audio/sfx/, without its extension. */
export type SfxName = string;

interface SoundRule {
  /** The file, or null when the game is silent here. */
  sfx: SfxName | null;
  /** The game's volume for it, 1 when omitted. */
  volume?: number;
  /** Why, when it is null. */
  why?: string;
}

/**
 * Simulation event to sound. Every member of `SimEvent["type"]` appears, so
 * adding a new event type is a type error until someone decides what it sounds
 * like.
 */
export const EVENT_SOUNDS: Record<SimEvent["type"], SoundRule> = {
  // Unless the Options trigger's key 576 asks for silence; see EventDrain.
  // [gdp PlayLayer::destroyPlayer, gd-ida-decomp.cpp:93293-93297]
  die: { sfx: "explode_11", volume: 0.65 },
  // Outside practice, and unless an End trigger's key 461 asks for silence;
  // see EventDrain. [gdp PlayLayer::showCompleteEffect :88863-88866]
  finish: { sfx: "endStart_02" },
  // [gdp GJBaseGameLayer::pickupItem :420607 and collectedObject :459006 play
  //  nothing; secretKey is the new-best popup's, showNewBest :89553]
  collect: { sfx: null, why: "the game plays nothing when a collectible is picked up; secretKey is the new-best popup's" },
  checkpoint: { sfx: null, why: "the practice checkpoint sound is not established; counter003 has no call site" },
  jump: { sfx: null, why: "the cube is silent in 2.2; only the robot and spider animate" },
  land: { sfx: null, why: "no landing sound in 2.2" },
  orb: { sfx: null, why: "orbs are silent; the ring's animation is the feedback" },
  pad: { sfx: null, why: "pads are silent" },
  portal: { sfx: null, why: "the portal circle is visual only" },
  flip: { sfx: null, why: "a gravity flip is silent; the portal it came from is the cue" },
  dashStart: { sfx: null, why: "the dash streak is visual only" },
  dashEnd: { sfx: null, why: "as dashStart" },
  break: { sfx: null, why: "breakable blocks have no sound of their own in 2.2" },
};

/**
 * Menu and interface sounds, by what they are for rather than by file name.
 *
 * Only what the decompile actually calls. The first draft of this table had a
 * `select` mapped to `buyItem01` for tapping a level — `buyItem01` has **no call
 * site at all** in the binary, and it is the shop's chest sound, which is what
 * it sounded like. `unlockGauntlet` and `counter003` were invented the same way
 * and are gone too.
 *
 * The menus are quiet: forward and back, and that is nearly all of it. Tapping a
 * level in the list makes no sound in the game, so it makes none here.
 */
export const UI_SOUNDS = {
  /** Going forward into a screen or starting a level. */
  play: "playSound_01",
  /** Going back out of one. */
  back: "quitSound_01",
  newBest: "highscoreGet02",
  achievement: "achievement_01",
  /** An icon tapped on the main menu, at half volume. [gdp MenuGameLayer::destroyPlayer :237556-237557] */
  menuDeath: "explode_11",
} as const;

export type UiSound = keyof typeof UI_SOUNDS;

/**
 * The file an SFX trigger asks for. The trigger carries the library id in key
 * 392 and the library is named after it, so this is mechanical — `s10117.ogg`
 * for id 10117. Ids the build did not ship simply do not play.
 */
export function triggerSfxName(id: number): SfxName {
  return `s${Math.trunc(id)}`;
}

/** Where a sound file lives under assets/, for the extension the device can play. */
export function sfxPath(name: SfxName, ext: "ogg" | "m4a"): string {
  return `audio/sfx/${name}.${ext}`;
}

export function musicPath(file: string): string {
  return `audio/music/${file}`;
}

/**
 * A custom song: music-library ids (above 9,999,999) are Ogg — or the m4a the
 * build writes beside each for Safari — and Newgrounds ids are mp3, which the
 * port does not ship. [gdp MusicDownloadManager::pathForSong :394118-394141]
 */
export function songPath(id: number, codec: "ogg" | "m4a"): string {
  return id > 9_999_999 ? `audio/songs/${id}.${codec}` : `audio/songs/${id}.mp3`;
}

/** The practice track. [gdp GameManager::getPracticeMusicFile :108846-108870] */
export const PRACTICE_MUSIC = "StayInsideMe.mp3";

/** Menu music. The game's own file names; there is nothing to derive. */
export const MENU_MUSIC = {
  menu: "menuLoop.mp3",
  shop: "shop.mp3",
  secret: "secretLoop.mp3",
  tower: "tower01.mp3",
  danger: "dangerLoop.mp3",
} as const;
