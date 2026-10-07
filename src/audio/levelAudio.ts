// One level's sound: its track, its audio triggers, the practice track, a
// death and a finish.
//
// Written against two small interfaces rather than Web Audio, so every
// decision here runs under `node --test` with recorders standing in for the
// players; GameAudio hands it the real ones. Channel numbers are the game's
// (key 432); voice numbers are this file's own.
//
// Nothing here changes what the simulation computes. The sim notes when each
// audio trigger fired and on what music clock; this works out what that
// sounds like from the trigger's own keys, and keeps a log of what it did
// (AudioScript) so a respawn, a start position or the pause menu can put the
// sound back as it was at any music time.

import type { Level } from "../level/types";
import type { Sim } from "../physics/types";
import type { TriggerEvent } from "../triggers/runtime";
import { EventDrain, type SoundSink } from "./events";
import { musicPath, PRACTICE_MUSIC, songPath, triggerSfxName } from "./names";
import { proximityFor, type ProximityWorld } from "./proximity";
import { AudioScript, type LengthOf, type SfxEditRecord, type SfxRecord, type VoiceState } from "./script";
import { levelSongPositionMs, songPositionMs, songState } from "./songState";
import { audioParams, AUDIO_TRIGGER_IDS, sfxRefId, uniqueSfxId, type AudioTriggerParams } from "./triggerAudio";

/** What a music channel is told to play. */
export interface ChannelPlay {
  path: string;
  /** Where in the file, in ms, at the moment of the call. */
  positionMs: number;
  rate: number;
  volume: number;
  loop: boolean;
  /** The loop's region; 0 and 0 loop the whole file. */
  loopStartMs: number;
  loopEndMs: number;
  /** Unlooped: stop at this ms of the file; 0 plays to its end. */
  endMs: number;
  fadeInMs: number;
  /** Unlooped: a fade-out ending at `endMs`, or at the file's end. */
  fadeOutMs: number;
  /** Kept to the level's music clock: a start that has to wait for a decode advances by the wait. */
  synced: boolean;
}

/** What LevelAudio asks of the music side. */
export interface MusicOut {
  /** Replaces whatever the channel plays. */
  start(channel: number, play: ChannelPlay): void;
  stop(channel: number): void;
  stopAll(): void;
  /** Every channel goes quiet, its song still held for the start that replaces it (FMOD pauseAllMusic). */
  pauseAll(): void;
  /** The current pass plays out and the loop ends (FMOD setLoopCount(0)). */
  endLoop(channel: number): void;
  volume(channel: number, to: number, over: number): void;
  speed(channel: number, to: number, over: number): void;
  /** Proximity: a factor on the channel's volume that outlives its song. */
  volumeMod(channel: number, mod: number): void;
  /** fadeInMusic: 0 up to 1. */
  fadeIn(channel: number, seconds: number): void;
  /** fadeOutMusic: down to 0. */
  fadeOut(channel: number, seconds: number): void;
  /** fadeInBackgroundMusic: the whole of the level's music from 0 back to 1. */
  busFadeIn(seconds: number): void;
  /** Decode ahead, for a song a Song trigger has prepared. */
  prepare(path: string): void;
  /** The path the channel plays, or null. */
  playing(channel: number): string | null;
}

/** What a voice is told to play. */
export interface VoicePlay {
  /** "s10117" */
  name: string;
  /** Key 455, 0 for none. */
  group: number;
  /** Where in the file to start, in ms; the player wraps a loop. */
  offsetMs: number;
  rate: number;
  /** A pitch shift that keeps the length, 1 for none. */
  pitch: number;
  fft2048: boolean;
  volume: number;
  loop: boolean;
  loopStartMs: number;
  loopEndMs: number;
  /** Unlooped: stop at this ms of the file; 0 plays to its end. */
  endMs: number;
  fadeInMs: number;
  fadeInDoneMs: number;
  fadeOutMs: number;
  /** Key 407: through the level's reverb as well as dry. */
  reverb: boolean;
}

/** What LevelAudio asks of the effects side. */
export interface SfxOut {
  play(voice: number, v: VoicePlay): void;
  /** Now, or once the current pass of its loop is over. */
  stop(voice: number, afterLoop: boolean): void;
  volume(voice: number, to: number, over: number): void;
  speed(voice: number, to: number, over: number): void;
  volumeMod(voice: number, mod: number): void;
  groupVolume(group: number, to: number, over: number): void;
  groupSpeed(group: number, to: number, over: number): void;
  groupVolumeMod(group: number, mod: number): void;
  /** The level's reverb switched to a preset (reverb.ts); a reset puts it back to 0. */
  reverbPreset(preset: number): void;
  stopAll(): void;
  /** A one-shot outside the triggers: a death, a finish. */
  effect(name: string, volume: number): void;
  /** The one-shots still sounding, cut. */
  stopEffects(): void;
  /** A sound's length in ms, 0 when it is not loaded. */
  lengthMs(name: string): number;
  /** Whether a voice is still sounding. */
  playing(voice: number): boolean;
}

type Target = { kind: "music" | "voice" | "group"; key: number };

/**
 * A track that loops from its start, as playMusic plays one, whenever it is
 * ready. [gdp FMODAudioEngine::playMusic :71410-71432 → loadMusic at 0 :71427]
 */
export function loopFromStart(path: string): ChannelPlay {
  return { path, positionMs: 0, rate: 1, volume: 1, loop: true, loopStartMs: 0, loopEndMs: 0, endMs: 0, fadeInMs: 0, fadeOutMs: 0, synced: false };
}

const f = Math.fround;

/**
 * The level's own track fades in over two seconds from a fresh start of a
 * kA15 level. [gdp PlayLayer::startMusic :105406-105410 → fadeInMusic(2.0, 0)]
 */
const TRACK_FADE_IN = 2;

export class LevelAudio implements SoundSink {
  private readonly params = new Map<number, AudioTriggerParams>();
  private readonly triggerGroups = new Map<number, number[]>();
  private readonly drain = new EventDrain();
  /** Null in practice: without sync the level's audio does nothing. */
  private script: AudioScript | null = null;
  private practice = false;
  private readonly effects = new Map<string, { target: Target; p: AudioTriggerParams }>();
  private readonly mods = new Map<string, number>();
  private camera: readonly [number, number] = [0, 0];

  constructor(
    readonly level: Level,
    readonly levelId: number,
    /** The level's own music, null for none. */
    readonly track: string | null,
    private readonly music: MusicOut,
    private readonly sfx: SfxOut,
    private readonly codec: "ogg" | "m4a" = "ogg",
  ) {
    for (const o of level.objects) {
      if (!AUDIO_TRIGGER_IDS.has(o.id)) continue;
      this.params.set(o.index, audioParams(o));
      if (o.id !== 3602) continue;
      for (const g of o.groups) {
        let list = this.triggerGroups.get(g);
        if (!list) {
          list = [];
          this.triggerGroups.set(g, list);
        }
        list.push(o.index);
      }
    }
  }

  /** Every audio trigger's settings, for the loader's preloads. */
  get triggers(): Iterable<AudioTriggerParams> {
    return this.params.values();
  }

  /**
   * A new attempt. From the start: the level's track, then the triggers as
   * they come. From a start position: whatever the warm-up's triggers left
   * running. In practice: the practice track, which a restart leaves playing.
   * The last attempt's sounds stop, its death or finish included.
   * [gdp PlayLayer::resetLevel :105772-105778 (stopAllEffects; pauseAudio
   *  outside practice); EndLevelLayer::onReplay :367255-367285 (clearAllAudio
   *  :66775-66783); PlayLayer::startMusic :105384-105425]
   */
  startAttempt(sim: Sim, practice: boolean, musicTime = sim.triggers.musicTime): void {
    this.practice = practice;
    this.sfx.stopAll();
    this.sfx.stopEffects();
    this.sfx.reverbPreset(0);
    this.effects.clear();
    this.mods.clear();
    if (practice) {
      this.script = null;
      const path = musicPath(PRACTICE_MUSIC);
      if (this.music.playing(0) !== path) {
        this.music.stopAll();
        this.music.start(0, loopFromStart(path));
      }
      // startMusic's fade has no practice check. [:105406-105410]
      if (musicTime <= 0 && this.level.header.fadeIn) this.music.fadeIn(0, TRACK_FADE_IN);
      this.drain.skip(sim);
      return;
    }
    this.music.stopAll();
    this.script = new AudioScript(this.triggerGroups);
    if (sim.startPosition < 0 && !sim.spoofedStart) {
      this.startLevelTrack(musicTime, musicTime <= 0 && this.level.header.fadeIn);
      this.drain.reset();
      return;
    }
    // The warm-up's audio triggers, decided now, then the sound at the music
    // time it reached. [startMusic :105411-105415 → processActivatedAudioTriggers]
    const world = this.world(sim);
    sim.triggers.events.forEach((e, seq) => this.decide(e, seq, sim, world, "start"));
    this.rebuild(sim, musicTime, "start");
    if (musicTime <= 0 && this.level.header.fadeIn && this.script.music().trackOnChannelZero()) {
      this.music.fadeIn(0, TRACK_FADE_IN);
    }
    this.drain.skip(sim);
  }

  /**
   * Back at a checkpoint. The songs pick up where they would be at its music
   * time and the sounds that were playing then play on from where they were;
   * a platformer's music comes back in over a tenth of a second. Practice
   * restores nothing. `kept` is how many trigger events the checkpoint kept
   * (Sim.respawnFrom): what its key 448 spawned after them plays live, as it
   * comes after the load. The reverb goes back to preset 0 and stays there:
   * the sounds come back with their key 407, but the checkpoint does not
   * keep the preset. [gdp PlayLayer::resetLevel :105772-105778, :105781 →
   *  resetLevelVariables :462921 (updateReverb(0)); loadFromCheckpoint
   *  :105531-105544; loadAudioState :74331-74397; the spawn :105965-105973]
   */
  respawn(sim: Sim, practice: boolean, kept: number): void {
    this.practice = practice;
    this.sfx.stopAll();
    this.sfx.stopEffects();
    this.sfx.reverbPreset(0);
    if (practice || !this.script) {
      this.drain.skip(sim, kept);
      return;
    }
    this.music.stopAll();
    this.script.truncate(kept);
    this.rebuild(sim, sim.triggers.musicTime, "checkpoint");
    if (this.level.header.platformer) this.music.busFadeIn(0.1);
    this.drain.skip(sim, kept);
  }

  /**
   * Practice from the pause menu: the level goes on, and its music stops for
   * the practice track. Its sounds play on, their proximity with them, until
   * the next death or reset. [gdp PlayLayer::togglePracticeMode :107466-107480;
   *  PauseLayer::onPracticeMode :235339-235350; GJBaseGameLayer::update
   *  :470071 → updateProximityVolumeEffects]
   */
  enterPractice(): void {
    this.practice = true;
    this.script = null;
    this.music.stopAll();
    this.music.start(0, loopFromStart(musicPath(PRACTICE_MUSIC)));
    // The mixer let go of the channels' proximity factors; the next frame
    // sets them all again, on the practice track too.
    this.mods.clear();
  }

  /**
   * The level is complete: the song on channel 0 stops looping, and fades
   * over two seconds with kA16 or on The Challenge. Practice has no complete
   * effect, so its music is left alone. What the frame's earlier steps fired
   * is heard first, as the game played it before the finish.
   * [gdp PlayLayer::levelComplete :92891-92904; showCompleteEffect :88965-88974]
   */
  finish(sim: Sim, practice: boolean): void {
    this.drain.drain(sim, this, practice);
    if (practice) return;
    this.music.endLoop(0);
    if (this.level.header.fadeOut || this.levelId === 3001) this.music.fadeOut(0, 2);
  }

  /**
   * A death stops the sounds, and outside practice pauses the music, unless
   * the Options trigger's key 575 keeps them. What the frame's steps fired
   * before the death is heard first, so the death stops it as the game's
   * does; the death's own sound, which the game plays after the stop, plays
   * out.
   * [gdp PlayLayer::destroyPlayer :93283-93297]
   */
  playerDied(sim: Sim, practice: boolean): void {
    this.drain.drain(sim, this, practice);
    if (sim.triggers.visual.options.audioOnDeath) return;
    if (!practice) this.music.pauseAll();
    this.sfx.stopAll();
  }

  /** One frame: what the sim did, then proximity. [GJBaseGameLayer::update :470071] */
  update(sim: Sim, camera: readonly [number, number] = this.camera): void {
    this.camera = camera;
    this.drain.drain(sim, this, this.practice);
    if (this.effects.size > 0) this.updateProximity(this.world(sim));
  }

  // --- SoundSink -------------------------------------------------------------

  effect(name: string, volume: number): void {
    this.sfx.effect(name, volume);
  }

  trigger(e: TriggerEvent, sim: Sim, seq: number): void {
    if (this.practice || !this.script) return;
    this.decide(e, seq, sim, this.world(sim), "live");
  }

  // --- the triggers ----------------------------------------------------------

  /**
   * One audio trigger: note it and, live, sound it. In "start" mode (a
   * start position's warm-up) nothing is heard yet; the rebuild plays what
   * is left.
   */
  private decide(e: TriggerEvent, seq: number, sim: Sim, world: ProximityWorld, mode: "live" | "start"): void {
    const script = this.script;
    const p = e.object === undefined ? undefined : this.params.get(e.object);
    if (!script || !p) return;
    const at = e.at ?? sim.triggers.musicTime;
    const live = mode === "live";
    switch (e.kind) {
      case "song": {
        script.log.push({ kind: "song", seq, at, p });
        if (live) this.song(p, at, sim.triggers.musicTime, script);
        return;
      }
      case "songEdit": {
        script.log.push({ kind: "songEdit", seq, at, p });
        if (live) this.songEdit(p, world);
        return;
      }
      case "sfx": {
        const r = this.sfxRecord(seq, p, at, world, mode, script);
        script.log.push(r);
        if (!live) return;
        if (r.preset !== null) this.sfx.reverbPreset(r.preset);
        if (r.replaced !== null) this.sfx.stop(r.replaced, false);
        if (r.voice === null) return;
        this.sfx.play(r.voice, this.voicePlay(p, null, "live"));
        if (p.target > 0) this.addProximity({ kind: "voice", key: r.voice }, p, world);
        return;
      }
      case "sfxEdit": {
        const r = this.sfxEditRecord(seq, p, at, mode, script);
        script.log.push(r);
        if (live) this.sfxEdit(r, world);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A Song trigger. A load (400) plays what its channel prepared, with the
   * prep's settings; a prep (399) only decodes; any other plays now, on its
   * own channel, replacing only that channel's song.
   * [gdp GJBaseGameLayer::activateSongTrigger :446501-446556;
   *  FMODAudioEngine::queueStartMusic :72427-72516, activateQueuedMusic
   *  :72528-72560, triggerQueuedMusic :71645-71701, startMusic :70651-70800]
   */
  private song(p: AudioTriggerParams, at: number, now: number, script: AudioScript): void {
    const book = script.music();
    const ch = book.channels.get(p.channel);
    if (p.prep) {
      if (ch?.prep === p) this.music.prepare(songPath(p.soundId, this.codec));
      return;
    }
    const active = ch?.active;
    if (!active || ch.activeAt !== at) return;
    // Positioned at the clock the frame's drain sees, so a song fired earlier
    // in the frame starts that far in.
    this.music.start(p.channel, this.livePlay(active, at, now));
  }

  /** What a Song trigger plays when it fires. */
  private livePlay(p: AudioTriggerParams, at: number, now: number): ChannelPlay {
    const regioned = p.loop && (p.startMs > 0 || p.endMs > 0);
    return {
      path: songPath(p.soundId, this.codec),
      positionMs: songPositionMs(p.startMs, at, now, p.speed, false, 0),
      rate: p.speed,
      volume: p.volume,
      loop: p.loop,
      loopStartMs: regioned ? p.startMs : 0,
      loopEndMs: regioned && p.endMs > 0 ? p.endMs : 0,
      endMs: !p.loop && p.endMs > p.startMs ? p.endMs : 0,
      fadeInMs: Math.max(0, p.fadeInMs),
      fadeOutMs: p.loop ? 0 : Math.max(0, p.fadeOutMs),
      synced: true,
    };
  }

  /**
   * An Edit Song: its channel stops (417), ends its loop (414), changes speed
   * (419) or volume (418) over key 10; with key 51 it also follows a group by
   * distance. It never starts anything.
   * [gdp GJBaseGameLayer::activateSongEditTrigger :447107-447128 →
   *  applySFXEditTrigger :431769-431804, addProximityVolumeEffect :447022-447092]
   */
  private songEdit(p: AudioTriggerParams, world: ProximityWorld): void {
    const c = p.channel;
    if (p.stop && !p.stopLoop) this.music.stop(c);
    else if (p.stop || p.stopLoop) this.music.endLoop(c);
    if (p.changeSpeed) this.music.speed(c, p.speed, p.duration);
    if (p.changeVolume) this.music.volume(c, p.volume, p.duration);
    if (p.target > 0) this.addProximity({ kind: "music", key: c }, p, world);
  }

  /**
   * An SFX trigger's decision: proximity silence, the minimum interval, and a
   * unique sound already playing. Live, key 503 switches the reverb to key
   * 502's preset once proximity has let the trigger through, whether or not
   * the sound then plays; while a start position loads it only notes.
   * [gdp GJBaseGameLayer::activateSFXTrigger :447147-447225 (the reverb
   *  :447202-447206, after the proximity check and before the rest) →
   *  GameManager::playSFXTrigger :108930-109007 → playEffectAdvanced
   *  :73942-74280 (the interval :74266-74277, unique :74067-74082);
   *  canProcessSFX :454608-454730 for the warm-up]
   */
  private sfxRecord(seq: number, p: AudioTriggerParams, at: number, world: ProximityWorld, mode: "live" | "start", script: AudioScript): SfxRecord {
    const r: SfxRecord = { kind: "sfx", seq, at, p, voice: null, stamp: null, replaced: null, preset: null };
    if (p.target > 0 && !p.playWhenSilent && proximityFor(p, world) <= 0) return r;
    if (p.reverbApply && mode === "live") r.preset = p.reverbPreset;
    const unique = uniqueSfxId(p);
    // The engine keys the interval by the SFX ref id; the warm-up's replay by
    // the unique id or the trigger's own. They differ only for key 416 on a
    // sound that is not unique.
    const key = mode === "start" ? unique || -p.object : sfxRefId(p);
    if (p.minInterval > 0) {
      const last = script.lastStamp(key);
      if (last !== undefined && f(at - last) < p.minInterval) return r;
      r.stamp = key;
    }
    if (unique !== 0) {
      const playing = script.uniqueVoice(unique, at, this.lengthOf(mode));
      if (playing) {
        if (!p.override) return r;
        // One already letting its loop run out is left to finish.
        if (!script.voiceStopping(playing.voice as number, at)) r.replaced = playing.voice;
      }
    }
    r.voice = script.newVoice();
    return r;
  }

  /**
   * An Edit SFX's reach, at the moment it fires: the sounds of the SFX
   * triggers in group 457, the SFX group 455, and the unique sound 416.
   * [gdp GJBaseGameLayer::activateSFXEditTrigger :447241-447359]
   */
  private sfxEditRecord(seq: number, p: AudioTriggerParams, at: number, mode: "live" | "start", script: AudioScript): SfxEditRecord {
    const length = this.lengthOf(mode);
    return {
      kind: "sfxEdit",
      seq,
      at,
      p,
      voices: p.triggerGroup > 0 ? script.voicesOfTriggerGroup(p.triggerGroup) : [],
      unique: p.sfxId > 0 ? (script.uniqueVoice(p.sfxId, at, length)?.voice ?? null) : null,
      groupVoices: p.sfxGroup > 0 ? script.voicesOfSfxGroup(p.sfxGroup, at, length) : [],
    };
  }

  private sfxEdit(r: SfxEditRecord, world: ProximityWorld): void {
    const p = r.p;
    for (const voice of r.voices) {
      this.applyEdit({ kind: "voice", key: voice }, p, r);
      if (p.target > 0) this.addProximity({ kind: "voice", key: voice }, p, world);
    }
    if (p.sfxGroup > 0) {
      this.applyEdit({ kind: "group", key: p.sfxGroup }, p, r);
      if (p.target > 0) this.addProximity({ kind: "group", key: p.sfxGroup }, p, world);
    }
    if (r.unique !== null) this.applyEdit({ kind: "voice", key: r.unique }, p, r);
  }

  /**
   * Stop (417, or 414 to let the loop run out: `stopChannel` takes 414 as its
   * flag), speed (419) and volume (418) over key 10. A group's stop reaches
   * the sounds in it; its speed and volume are the group's own, which sounds
   * started in it later inherit. [gdp applySFXEditTrigger :431769-431804;
   *  FMODAudioEngine::stopChannel :71926-72060, updateChannel :70808-70890]
   */
  private applyEdit(t: Target, p: AudioTriggerParams, r: SfxEditRecord): void {
    if (p.stop || p.stopLoop) {
      if (t.kind === "voice") this.sfx.stop(t.key, p.stopLoop);
      else for (const v of r.groupVoices) this.sfx.stop(v, p.stopLoop);
    }
    if (p.changeSpeed) {
      if (t.kind === "voice") this.sfx.speed(t.key, p.speed, p.duration);
      else this.sfx.groupSpeed(t.key, p.speed, p.duration);
    }
    if (p.changeVolume) {
      if (t.kind === "voice") this.sfx.volume(t.key, p.volume, p.duration);
      else this.sfx.groupVolume(t.key, p.volume, p.duration);
    }
  }

  // --- building the sound at a music time ------------------------------------

  private startLevelTrack(T: number, fade: boolean): void {
    if (!this.track) return;
    this.music.start(0, {
      path: this.track,
      positionMs: levelSongPositionMs(this.level.header.songOffset, T),
      rate: 1,
      volume: 1,
      loop: this.level.header.platformer,
      loopStartMs: 0,
      loopEndMs: 0,
      endMs: 0,
      fadeInMs: fade ? TRACK_FADE_IN * 1000 : 0,
      fadeOutMs: 0,
      synced: true,
    });
  }

  /**
   * Everything the log says is sounding at music time T: each channel's song
   * where it would be, the level's track on channel 0 unless a Song trigger
   * took it or an Edit Song stopped it, the prepared songs, the SFX groups'
   * settings, the sounds still playing, and the proximity effects.
   * [gdp processActivatedAudioTriggers :454746-455240; loadAudioState :74331-74397]
   */
  private rebuild(sim: Sim, T: number, mode: "checkpoint" | "start"): void {
    const script = this.script;
    if (!script) return;
    const book = script.music();
    for (const [c, ch] of book.channels) {
      if (ch.prep) this.music.prepare(songPath(ch.prep.soundId, this.codec));
      const s = book.stateOf(c, T);
      if (!s || !ch.active) continue;
      const p = ch.active;
      const regioned = p.loop && (p.startMs > 0 || p.endMs > 0);
      let pos = s.positionMs;
      if (p.loop && p.endMs > p.startMs) pos = ((pos - p.startMs) % (p.endMs - p.startMs)) + p.startMs;
      // A replayed song is loaded fresh with its loop points and nothing
      // else: no fades and no end. [processActivatedAudioTriggers :454862-454917]
      this.music.start(c, {
        path: songPath(p.soundId, this.codec),
        positionMs: pos,
        rate: s.speed,
        volume: s.volume,
        loop: p.loop,
        loopStartMs: regioned ? p.startMs : 0,
        loopEndMs: regioned && p.endMs > 0 ? p.endMs : 0,
        endMs: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        synced: true,
      });
      this.tweens(c, s);
    }
    if (book.trackOnChannelZero() && this.track) {
      const s = songState(Math.trunc(f(f(this.level.header.songOffset) * 1000)), 0, T, 1, 1, book.songEdits(0));
      this.music.start(0, {
        path: this.track,
        positionMs: s.positionMs,
        rate: s.speed,
        volume: s.volume,
        loop: this.level.header.platformer,
        loopStartMs: 0,
        loopEndMs: 0,
        endMs: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        synced: true,
      });
      this.tweens(0, s);
    }

    for (const g of script.editedGroups()) {
      const s = script.groupAt(g, T);
      this.sfx.groupVolume(g, s.volume[0], 0);
      if (s.volume[2] > 0) this.sfx.groupVolume(g, s.volume[1], s.volume[2]);
      this.sfx.groupSpeed(g, s.speed[0], 0);
      if (s.speed[2] > 0) this.sfx.groupSpeed(g, s.speed[1], s.speed[2]);
    }
    const lengthOf = this.lengthOf(mode === "start" ? "start" : "live");
    const alive = new Set<number>();
    for (const r of script.voices()) {
      const v = script.voiceAt(r, T, lengthOf);
      if (!v.alive) continue;
      const voice = r.voice as number;
      alive.add(voice);
      // A start position's replay fires each sound's trigger again, so its
      // key 503 switches the reverb as it would have. [processActivatedAudioTriggers
      //  :455196 → activateSFXTrigger :447202-447206]
      if (mode === "start" && r.p.reverbApply) this.sfx.reverbPreset(r.p.reverbPreset);
      this.sfx.play(voice, this.voicePlay(r.p, v, mode));
      if (v.volume[2] > 0) this.sfx.volume(voice, v.volume[1], v.volume[2]);
      if (v.speed[2] > 0) this.sfx.speed(voice, v.speed[1], v.speed[2]);
    }

    // The proximity effects are game state: those the log added come back.
    this.effects.clear();
    this.mods.clear();
    for (const r of script.log) {
      if (r.at > T || r.p.target <= 0) continue;
      if (r.kind === "songEdit") this.effects.set(`music:${r.p.channel}`, { target: { kind: "music", key: r.p.channel }, p: r.p });
      else if (r.kind === "sfx" && r.voice !== null && alive.has(r.voice)) this.effects.set(`voice:${r.voice}`, { target: { kind: "voice", key: r.voice }, p: r.p });
      else if (r.kind === "sfxEdit") {
        for (const v of r.voices) if (alive.has(v)) this.effects.set(`voice:${v}`, { target: { kind: "voice", key: v }, p: r.p });
        if (r.p.sfxGroup > 0) this.effects.set(`group:${r.p.sfxGroup}`, { target: { kind: "group", key: r.p.sfxGroup }, p: r.p });
      }
    }
    if (this.effects.size > 0) this.updateProximity(this.world(sim));
  }

  private tweens(c: number, s: { volume: number; volumeTarget: number; volumeLeft: number; speed: number; speedTarget: number; speedLeft: number }): void {
    if (s.volumeLeft > 0) this.music.volume(c, s.volumeTarget, s.volumeLeft);
    if (s.speedLeft > 0) this.music.speed(c, s.speedTarget, s.speedLeft);
  }

  /**
   * What a voice plays. Live: from its start. After a checkpoint it carries
   * on from where it was, fades and all, as the engine's saved state starts
   * it again. From a start position it is the trigger fired again — its
   * fade-in from the top — seeked by its key 490 length, with the end moved
   * only when it fades out, as the replay does.
   * [gdp playEffectAdvanced :74024-74170; loadAudioState :74331-74397;
   *  processActivatedAudioTriggers :455178-455216]
   */
  private voicePlay(p: AudioTriggerParams, v: VoiceState | null, mode: "live" | "checkpoint" | "start"): VoicePlay {
    const regioned = p.startMs > 0 || p.endMs > 0;
    const loop = v ? v.loop : p.loop;
    let offset = p.startMs > 0 ? p.startMs : 0;
    let endMs = !loop && p.endMs > p.startMs ? p.endMs : 0;
    let fadeInDone = 0;
    if (v && mode === "checkpoint") {
      offset = v.positionMs;
      fadeInDone = Math.min(v.elapsed * 1000, Math.max(0, p.fadeInMs));
    } else if (v && mode === "start") {
      const len = this.warmUpLength(p) - p.startMs;
      const advance = v.positionMs - p.startMs;
      offset = p.startMs + (len > 0 ? advance - Math.floor(advance / len) * len : advance);
      if (endMs > 0 && p.fadeOutMs <= 0) endMs = offset + (p.endMs - p.startMs);
    }
    return {
      name: triggerSfxName(p.soundId),
      group: p.sfxGroup,
      offsetMs: offset,
      rate: v ? v.speed[0] : p.speed,
      pitch: p.pitch,
      fft2048: p.fft2048,
      // Capped where it is played. [playEffectAdvanced :74065-74066]
      volume: Math.min(v ? v.volume[0] : p.volume, 2),
      loop,
      loopStartMs: loop && regioned ? Math.max(0, p.startMs) : 0,
      loopEndMs: loop && regioned && p.endMs > 0 ? p.endMs : 0,
      endMs,
      fadeInMs: Math.max(0, p.fadeInMs),
      fadeInDoneMs: fadeInDone,
      fadeOutMs: loop ? 0 : Math.max(0, p.fadeOutMs),
      // A restored sound keeps its own. [loadAudioState :74338, the flag :74346]
      reverb: p.reverb,
    };
  }

  /**
   * The length a sound runs, for deciding whether it is still sounding: its
   * own, or for the warm-up's replay key 490 — the sound's length as the
   * editor stored it, recorded times its speed. [activatedAudioTrigger
   * :447849-447855; processSFXState :432536]
   */
  private lengthOf(mode: "live" | "start"): LengthOf {
    return mode === "start" ? (p) => this.warmUpLength(p) : (p) => this.sfx.lengthMs(triggerSfxName(p.soundId));
  }

  private warmUpLength(p: AudioTriggerParams): number {
    return p.length > 0 ? p.startMs + f(f(p.speed * p.length) * 1000) : 0;
  }

  // --- proximity ---------------------------------------------------------------

  private addProximity(t: Target, p: AudioTriggerParams, world: ProximityWorld): void {
    const key = `${t.kind}:${t.key}`;
    this.effects.set(key, { target: t, p });
    this.setMod(key, t, proximityFor(p, world));
  }

  /**
   * Every frame, each effect's volume again. A voice that has finished has
   * nothing left to turn up or down, so its effect goes.
   * [gdp GJBaseGameLayer::updateProximityVolumeEffects :432247-432275]
   */
  private updateProximity(world: ProximityWorld): void {
    for (const [key, { target, p }] of this.effects) {
      if (target.kind === "voice" && !this.sfx.playing(target.key)) {
        this.effects.delete(key);
        this.mods.delete(key);
        continue;
      }
      this.setMod(key, target, proximityFor(p, world));
    }
  }

  private setMod(key: string, t: Target, v: number): void {
    if (this.mods.get(key) === v) return;
    this.mods.set(key, v);
    if (t.kind === "music") this.music.volumeMod(t.key, v);
    else if (t.kind === "voice") this.sfx.volumeMod(t.key, v);
    else this.sfx.groupVolumeMod(t.key, v);
  }

  private world(sim: Sim): ProximityWorld {
    const trig = sim.triggers;
    const p2 = sim.state2;
    return {
      player1: [sim.state.x, sim.state.y],
      player2: p2 ? [p2.x, p2.y] : null,
      camera: this.camera,
      members: (g) => trig.groupMembers(g),
      position: (i) => trig.objectPosition(i),
      disabled: (i) => trig.objectDisabled(i),
      mainObject: (g) => trig.mainObjectOf(g),
    };
  }
}
