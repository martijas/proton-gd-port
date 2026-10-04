// An audio trigger's settings, read the way the game reads them.
//
// Song (1934), SFX (3602), Edit SFX (3603) and Edit Song (3605) are one object
// class in the game, so one reader serves all four. Every field is `atoi`,
// `atof` or `atoi != 0` of its key and 0 when the key is absent — a volume
// included, which is why an SFX trigger saved without key 406 is silent.
// [gdp SFXTriggerGameObject::customObjectSetup, gd-ida-decomp.cpp:309521-309772
//  (407 :309597-309600, 502 and 503 :309751-309758);
//  SongTriggerGameObject::customObjectSetup :309776-309800; getSaveString
//  :322152-322157 writes 406 only when it is not 0]

import type { LevelObject } from "../level/types";
import { pitchForIdx } from "./pitch";

export type AudioTriggerId = 1934 | 3602 | 3603 | 3605;

/** The four audio triggers. */
export const AUDIO_TRIGGER_IDS: ReadonlySet<number> = new Set([1934, 3602, 3603, 3605]);

export interface AudioTriggerParams {
  id: AudioTriggerId;
  /** The trigger's object index, which is also its unique id. */
  object: number;
  /** 392: the SFX library id, or the custom song id. */
  soundId: number;
  /** 404 through pitchForIdx: the playback rate. */
  speed: number;
  /** 405 through pitchForIdx: a pitch shift that keeps the length (SFX only). */
  pitch: number;
  /** 406, a float; 0 when absent. */
  volume: number;
  /** 412: the pitch shifter's FFT is 2048 rather than 1024. */
  fft2048: boolean;
  /** 407: the sound goes through the level's reverb. [+1676, playSFXTrigger :108974 as playEffectAdvanced's a8] */
  reverb: boolean;
  /** 502: the reverb preset this trigger switches to (see reverb.ts). [+1740] */
  reverbPreset: number;
  /** 503: switch the reverb to key 502's preset when it plays. [+1744, activateSFXTrigger :447202-447206] */
  reverbApply: boolean;
  /** 413 */
  loop: boolean;
  /** 414, on an edit: stop at the end of the current pass. */
  stopLoop: boolean;
  /** 415 */
  unique: boolean;
  /** 416: the SFX id a unique sound registers under, or an Edit SFX aims at. */
  sfxId: number;
  /** 420: a unique sound replaces one already playing. */
  override: boolean;
  /** 408-411, in ms of the file. */
  startMs: number;
  fadeInMs: number;
  endMs: number;
  fadeOutMs: number;
  /** 417-419, on an edit. */
  stop: boolean;
  changeVolume: boolean;
  changeSpeed: boolean;
  /** 10: seconds an edit takes, as a float. */
  duration: number;
  /** 51 and 71: the proximity group, and the group whose object listens. */
  target: number;
  target2: number;
  /** 421-423: the proximity volumes near, in the middle and far. */
  near: number;
  mid: number;
  far: number;
  /** 424-426: the proximity distances, in threes of units, never below 0. */
  d1: number;
  d2: number;
  d3: number;
  /** 458: how the distance is measured (0-6). */
  distMode: number;
  /** 138, 200, 428: who listens — player 1, player 2, the camera's centre. */
  listenP1: boolean;
  listenP2: boolean;
  listenCamera: boolean;
  /** 489: play even when the proximity says silent. */
  playWhenSilent: boolean;
  /** 434: seconds before the same SFX may play again. */
  minInterval: number;
  /** 490: the sound's length in seconds as the editor stored it. */
  length: number;
  /** 455: the SFX group the sound plays in, or an Edit SFX aims at. */
  sfxGroup: number;
  /** 457: an Edit SFX's group of SFX triggers whose sounds it edits. */
  triggerGroup: number;
  /** 399, 400, 432: a Song trigger prepares, or plays what was prepared; the music channel. */
  prep: boolean;
  loadPrep: boolean;
  channel: number;
}

/** atoi: the leading integer, 0 for none. */
function atoi(v: string | undefined): number {
  return v === undefined ? 0 : parseInt(v, 10) || 0;
}

/** atof, into a float field. */
function atof(v: string | undefined): number {
  return v === undefined ? 0 : Math.fround(parseFloat(v) || 0);
}

export function audioParams(o: LevelObject): AudioTriggerParams {
  const k = o.props;
  const flag = (key: number): boolean => atoi(k[key]) !== 0;
  return {
    id: o.id as AudioTriggerId,
    object: o.index,
    soundId: atoi(k[392]),
    speed: pitchForIdx(atoi(k[404])),
    pitch: pitchForIdx(atoi(k[405])),
    volume: atof(k[406]),
    fft2048: flag(412),
    reverb: flag(407),
    reverbPreset: atoi(k[502]),
    reverbApply: flag(503),
    loop: flag(413),
    stopLoop: flag(414),
    unique: flag(415),
    sfxId: atoi(k[416]),
    override: flag(420),
    startMs: atoi(k[408]),
    fadeInMs: atoi(k[409]),
    endMs: atoi(k[410]),
    fadeOutMs: atoi(k[411]),
    stop: flag(417),
    changeVolume: flag(418),
    changeSpeed: flag(419),
    duration: atof(k[10]),
    target: atoi(k[51]),
    target2: atoi(k[71]),
    near: atof(k[421]),
    mid: atof(k[422]),
    far: atof(k[423]),
    d1: Math.max(0, atoi(k[424])),
    d2: Math.max(0, atoi(k[425])),
    d3: Math.max(0, atoi(k[426])),
    distMode: atoi(k[458]),
    listenP1: flag(138),
    listenP2: flag(200),
    listenCamera: flag(428),
    playWhenSilent: flag(489),
    minInterval: atof(k[434]),
    length: atof(k[490]),
    sfxGroup: atoi(k[455]),
    triggerGroup: atoi(k[457]),
    prep: flag(399),
    loadPrep: flag(400),
    channel: atoi(k[432]),
  };
}

/** Key 416 when set, else the trigger's own id negated. [gdp SFXTriggerGameObject::getSFXRefID :311876-311884] */
export function sfxRefId(p: AudioTriggerParams): number {
  return p.sfxId > 0 ? p.sfxId : -p.object;
}

/** The ref id for a unique sound, 0 otherwise. [gdp SFXTriggerGameObject::getUniqueSFXID :311900-311906] */
export function uniqueSfxId(p: AudioTriggerParams): number {
  return p.unique ? sfxRefId(p) : 0;
}
