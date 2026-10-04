// What the level's audio triggers have done this attempt, kept as a log so the
// state at any music time can be worked out again: a checkpoint respawn, or a
// start position's warm-up.
//
// The game keeps two things for this. The song channels — which song each
// music channel is playing and since when, a song prepared for later, and the
// Edit Songs since — live in the game state, and the checkpoint replay seeks
// every channel to where it would be now (processActivatedAudioTriggers →
// processSongState). The sound effects playing at a checkpoint are saved with
// the audio engine's state and started again where they were
// (saveAudioState/loadAudioState). A start position's warm-up notes its SFX
// triggers instead and replays the ones still sounding by their key 490
// length. The log serves both: each record is a decision already made — a
// sound that played, one that was refused, an edit and what it reached — and
// a fold over it gives the state at any time.
// [gdp GJBaseGameLayer::activatedAudioTrigger, gd-ida-decomp.cpp:447750-448043;
//  processActivatedAudioTriggers :454746-455240; FMODAudioEngine::saveAudioState
//  :68887-68928, loadAudioState :74331-74397; PlayLayer::loadFromCheckpoint
//  :105531-105544]

import { songState, tweenAt, type SongEdit, type TimedChange } from "./songState";
import { uniqueSfxId, type AudioTriggerParams } from "./triggerAudio";

export interface SongRecord {
  kind: "song";
  /** Its place in the trigger events, which a respawn cuts the log back to. */
  seq: number;
  at: number;
  p: AudioTriggerParams;
}

export interface SongEditRecord {
  kind: "songEdit";
  seq: number;
  at: number;
  p: AudioTriggerParams;
}

export interface SfxRecord {
  kind: "sfx";
  seq: number;
  at: number;
  p: AudioTriggerParams;
  /** The voice it started, or null when it was refused. */
  voice: number | null;
  /** The key its minimum interval stamped, or null. */
  stamp: number | null;
  /** A unique sound it cut off. */
  replaced: number | null;
  /** The reverb preset its key 503 switched to, or null. */
  preset: number | null;
}

export interface SfxEditRecord {
  kind: "sfxEdit";
  seq: number;
  at: number;
  p: AudioTriggerParams;
  /** Voices of the SFX triggers in group 457, which also take its proximity. */
  voices: number[];
  /** The unique sound key 416 reached, if any. */
  unique: number | null;
  /** The voices in SFX group 455 when it fired, which a stop reaches. */
  groupVoices: number[];
}

export type AudioRecord = SongRecord | SongEditRecord | SfxRecord | SfxEditRecord;

/** One music channel, as the game's SongChannelState keeps it. */
export interface SongChannel {
  active: AudioTriggerParams | null;
  activeAt: number;
  prep: AudioTriggerParams | null;
}

/**
 * The song channels: which Song trigger each is playing and since when, a
 * prepared one, and the Edit Songs since. A load (400) makes the prepared
 * song the channel's at its own time; a prep (399) waits; anything else
 * plays. An Edit Song with 417 clears the channel instead of being kept, and
 * on channel 0 it also keeps the level's own track from coming back.
 * [gdp activatedAudioTrigger :447814-447841 (1934), :447941-448022 (3605)]
 */
export class MusicBook {
  readonly channels = new Map<number, SongChannel>();
  readonly edits = new Map<number, Array<{ at: number; p: AudioTriggerParams }>>();
  trackStopped = false;

  private channel(c: number): SongChannel {
    let ch = this.channels.get(c);
    if (!ch) {
      ch = { active: null, activeAt: 0, prep: null };
      this.channels.set(c, ch);
    }
    return ch;
  }

  /** "start" when the channel's song changed, "prepare" for a 399, "none" for a load with nothing ready. */
  song(p: AudioTriggerParams, at: number): "start" | "prepare" | "none" {
    const ch = this.channel(p.channel);
    if (p.loadPrep) {
      const prep = ch.prep;
      if (prep) {
        ch.active = prep;
        ch.activeAt = at;
      }
      ch.prep = null;
      return prep ? "start" : "none";
    }
    if (p.prep) {
      ch.prep = p;
      return "prepare";
    }
    ch.active = p;
    ch.activeAt = at;
    return "start";
  }

  songEdit(p: AudioTriggerParams, at: number): void {
    if (p.stop) {
      this.channel(p.channel).active = null;
      if (p.channel === 0) this.trackStopped = true;
      return;
    }
    let list = this.edits.get(p.channel);
    if (!list) {
      list = [];
      this.edits.set(p.channel, list);
    }
    list.push({ at, p });
  }

  /** Whether channel 0 still carries the level's own track. [processActivatedAudioTriggers :454908-454919] */
  trackOnChannelZero(): boolean {
    if (this.trackStopped) return false;
    const ch = this.channels.get(0);
    return !ch || (!ch.active && !(ch.activeAt > 0));
  }

  songEdits(c: number): SongEdit[] {
    return (this.edits.get(c) ?? []).map(({ at, p }) => ({
      at,
      changeSpeed: p.changeSpeed,
      changeVolume: p.changeVolume,
      speed: p.speed,
      volume: p.volume,
      duration: p.duration,
    }));
  }

  /** Where a channel's song is at `now`. */
  stateOf(c: number, now: number): ReturnType<typeof songState> | null {
    const ch = this.channels.get(c);
    if (!ch?.active) return null;
    const p = ch.active;
    return songState(p.startMs, ch.activeAt, now, p.speed, p.volume, this.songEdits(c));
  }
}

/** A voice's state at some music time. */
export interface VoiceState {
  alive: boolean;
  /** File ms: inside its loop region while it still loops. */
  positionMs: number;
  /** Still looping: a 414 edit ends the loop. */
  loop: boolean;
  /** Seconds of music time since it started. */
  elapsed: number;
  speed: [number, number, number];
  volume: [number, number, number];
}

/**
 * How long a sound runs, for deciding whether one is still sounding: the
 * sound's own length in ms, 0 when it is not known (then it runs until stopped).
 */
export type LengthOf = (p: AudioTriggerParams) => number;

/** ∫ of the product of two straight lines over [0, h], by Simpson's rule (exact for it). */
function productIntegral(a0: number, a1: number, b0: number, b1: number, h: number): number {
  const am = (a0 + a1) / 2;
  const bm = (b0 + b1) / 2;
  return (h / 6) * (a0 * b0 + 4 * am * bm + a1 * b1);
}

export class AudioScript {
  readonly log: AudioRecord[] = [];
  private nextVoice = 1;

  constructor(
    /** The SFX triggers in each group, for an Edit SFX's key 457. */
    private readonly triggerGroups: ReadonlyMap<number, readonly number[]>,
  ) {}

  newVoice(): number {
    return this.nextVoice++;
  }

  /**
   * Drops everything the sim has taken back: the records of trigger events
   * from `kept` on. By event rather than by tick, because a checkpoint is
   * laid before its key 51 spawns in the same tick, and what that spawn
   * fired is not part of it. [gdp PlayLayer::postUpdate: markCheckpoint
   *  :105316 (createCheckpoint → saveAudioState :105120), then key 51
   *  :105352-105359]
   */
  truncate(kept: number): void {
    let n = this.log.length;
    while (n > 0 && this.log[n - 1].seq >= kept) n--;
    this.log.length = n;
  }

  music(): MusicBook {
    const book = new MusicBook();
    for (const r of this.log) {
      if (r.kind === "song") book.song(r.p, r.at);
      else if (r.kind === "songEdit") book.songEdit(r.p, r.at);
    }
    return book;
  }

  voices(): SfxRecord[] {
    return this.log.filter((r): r is SfxRecord => r.kind === "sfx" && r.voice !== null);
  }

  /** The last time a minimum interval stamped this key. */
  lastStamp(key: number): number | undefined {
    let last: number | undefined;
    for (const r of this.log) if (r.kind === "sfx" && r.stamp === key) last = r.at;
    return last;
  }

  /** Voices the SFX triggers in a group have started. [the +1376 map, activateSFXTrigger :447212-447217] */
  voicesOfTriggerGroup(group: number): number[] {
    const members = new Set(this.triggerGroups.get(group) ?? []);
    const out: number[] = [];
    for (const r of this.log) if (r.kind === "sfx" && r.voice !== null && members.has(r.p.object)) out.push(r.voice);
    return out;
  }

  /** Voices playing in an SFX group at `t`. */
  voicesOfSfxGroup(group: number, t: number, lengthOf: LengthOf): number[] {
    const out: number[] = [];
    for (const r of this.voices()) if (r.p.sfxGroup === group && this.voiceAt(r, t, lengthOf).alive) out.push(r.voice as number);
    return out;
  }

  /** The newest voice registered under a unique id that is still sounding at `t`. [channelIDForUniqueID] */
  uniqueVoice(unique: number, t: number, lengthOf: LengthOf): SfxRecord | null {
    const list = this.voices();
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (uniqueSfxId(r.p) === unique) {
        return this.voiceAt(r, t, lengthOf).alive ? r : null;
      }
    }
    return null;
  }

  /** Whether a 414 edit has already reached the voice by `t`: FMOD lets it finish. [playEffectAdvanced :74073-74078] */
  voiceStopping(voice: number, t: number): boolean {
    for (const r of this.log) {
      if (r.at > t) break;
      if (r.kind === "sfxEdit" && r.p.stopLoop && (r.voices.includes(voice) || r.unique === voice || r.groupVoices.includes(voice))) return true;
    }
    return false;
  }

  /** The group's volume and speed at `t`, and the tween left of each. [processSFXGroupEdit] */
  groupAt(group: number, t: number): { volume: [number, number, number]; speed: [number, number, number] } {
    const vol: TimedChange[] = [];
    const speed: TimedChange[] = [];
    for (const r of this.log) {
      if (r.kind !== "sfxEdit" || r.p.sfxGroup !== group || r.at > t) continue;
      if (r.p.changeVolume) vol.push({ at: r.at, to: r.p.volume, over: r.p.duration });
      if (r.p.changeSpeed) speed.push({ at: r.at, to: r.p.speed, over: r.p.duration });
    }
    return { volume: tweenAt(1, vol, t), speed: tweenAt(1, speed, t) };
  }

  /** Every SFX group an Edit SFX has touched. */
  editedGroups(): number[] {
    const out = new Set<number>();
    for (const r of this.log) if (r.kind === "sfxEdit" && r.p.sfxGroup > 0) out.add(r.p.sfxGroup);
    return [...out];
  }

  /**
   * A voice at music time `t`: whether it still sounds and where it is.
   * Position runs at its own speed times its group's, each a straight line
   * between edits; a stop (417) ends it, a 414 ends its loop and lets it play
   * out, a unique sound that overrode it cuts it off, and a sound that does not
   * loop ends at key 410 or at its own length.
   * [gdp processSFXState :432298-432537, the same walk by the engine's clock]
   */
  voiceAt(r: SfxRecord, t: number, lengthOf: LengthOf): VoiceState {
    const p = r.p;
    const voice = r.voice as number;
    const ownSpeed: TimedChange[] = [];
    const ownVolume: TimedChange[] = [];
    const groupSpeed: TimedChange[] = [];
    const stops: Array<{ at: number; now: boolean }> = [];
    let cutAt = Infinity;
    for (const e of this.log) {
      if (e.at > t) break;
      if (e.kind === "sfx" && e.replaced === voice) cutAt = Math.min(cutAt, e.at);
      if (e.kind !== "sfxEdit") continue;
      const own = e.voices.includes(voice) || e.unique === voice;
      const group = p.sfxGroup > 0 && e.p.sfxGroup === p.sfxGroup;
      if (group && e.p.changeSpeed) groupSpeed.push({ at: e.at, to: e.p.speed, over: e.p.duration });
      if (!own && !(group && e.groupVoices.includes(voice))) continue;
      if (e.p.stop || e.p.stopLoop) stops.push({ at: e.at, now: !e.p.stopLoop });
      if (own && e.p.changeSpeed) ownSpeed.push({ at: e.at, to: e.p.speed, over: e.p.duration });
      if (own && e.p.changeVolume) ownVolume.push({ at: e.at, to: e.p.volume, over: e.p.duration });
    }
    const end = Math.min(t, cutAt);
    const stopNow = stops.find((s) => s.now);
    const until = stopNow ? Math.min(end, stopNow.at) : end;
    const loopEndsAt = stops.find((s) => !s.now)?.at ?? Infinity;

    // Straight-line pieces of both speeds between every point either changes.
    const marks = new Set<number>([r.at, until]);
    for (const c of [...ownSpeed, ...groupSpeed]) {
      if (c.at > r.at && c.at < until) marks.add(c.at);
      if (c.at + c.over > r.at && c.at + c.over < until) marks.add(c.at + c.over);
    }
    if (loopEndsAt > r.at && loopEndsAt < until) marks.add(loopEndsAt);
    const times = [...marks].filter((m) => m >= r.at && m <= until).sort((a, b) => a - b);
    const own = (x: number): number => tweenAt(p.speed, ownSpeed.filter((c) => c.at <= x), x)[0];
    const grp = (x: number): number => tweenAt(1, groupSpeed.filter((c) => c.at <= x), x)[0];

    const length = lengthOf(p);
    const regioned = p.startMs > 0 || p.endMs > 0;
    const loopStart = regioned ? p.startMs : 0;
    const loopEnd = regioned && p.endMs > 0 ? p.endMs : length;
    const stopAt = p.endMs > p.startMs ? p.endMs : length;
    let pos = Math.max(0, p.startMs);
    let looping = p.loop;
    let alive = !(stopNow && stopNow.at <= end) && !(cutAt <= t);
    for (let i = 1; i < times.length; i++) {
      const a = times[i - 1];
      const b = times[i];
      pos += productIntegral(own(a), own(b), grp(a), grp(b), b - a) * 1000;
      if (looping && b >= loopEndsAt) {
        looping = false;
        if (loopEnd > loopStart && pos >= loopEnd) pos = loopStart + ((pos - loopStart) % (loopEnd - loopStart));
      }
    }
    if (looping) {
      if (loopEnd > loopStart && pos >= loopEnd) pos = loopStart + ((pos - loopStart) % (loopEnd - loopStart));
    } else {
      // Unlooped, or a loop told to finish: it plays out to its end, or to
      // the file's end once its loop has been let go.
      const last = p.loop ? length : stopAt;
      if (last > 0 && pos >= last) alive = false;
    }
    return {
      alive,
      positionMs: pos,
      loop: looping,
      elapsed: t - r.at,
      speed: tweenAt(p.speed, ownSpeed, t),
      volume: tweenAt(p.volume, ownVolume, t),
    };
  }
}
