// What the rest of the game talks to. One object: load a level, start an
// attempt, drain a frame, stop.
//
// The decisions — which song on which channel, where it is, what an SFX
// trigger sounds like, what a respawn puts back — are LevelAudio's; this
// wires it to the Web Audio players and loads what it will ask for.

import type { Strings } from "../assets/strings";
import type { Level } from "../level/types";
import type { Sim } from "../physics/types";
import { AudioEngine, type AudioSettings } from "./engine";
import { AudioLibrary } from "./library";
import { LevelAudio, loopFromStart } from "./levelAudio";
import { MENU_MUSIC, musicPath, sfxPath, songPath, triggerSfxName, UI_SOUNDS, type UiSound } from "./names";
import { MusicMixer } from "./music";
import { pitchShift } from "./pitchShift";
import { isMetered, MeterPulse, PULSE_FLAT, ScriptPulse } from "./pulse";
import { SfxPlayer } from "./sfx";

/** The one-shots outside the triggers that a level can play. */
const LEVEL_EFFECTS = ["explode_11", "endStart_02"];

/** The mixer channel the menus' music plays on, clear of the level's. */
const MENU_CHANNEL = -1;

export class GameAudio {
  readonly engine: AudioEngine;
  private readonly library: AudioLibrary;
  private readonly mixer: MusicMixer;
  private readonly sfxPlayer: SfxPlayer;
  private level: LevelAudio | null = null;
  /** The level's own track, held decoded while the level is loaded. */
  private track: string | null = null;
  /** The loaded level's pulse: its song's beat script, or the meter when it has none. */
  private script: ScriptPulse | null = null;
  private readonly meter = new MeterPulse();
  /** The two halves of the music's mix, for the meter's peak. */
  private readonly taps: AnalyserNode[];
  private readonly samples = new Float32Array(1024);

  constructor(
    private readonly strings: Strings,
    settings: AudioSettings = { music: 1, sfx: 1 },
  ) {
    this.engine = new AudioEngine(settings);
    this.library = new AudioLibrary(this.engine.ctx);
    this.mixer = new MusicMixer(this.engine.ctx, this.engine.musicBus, this.library);
    this.sfxPlayer = new SfxPlayer(this.engine.ctx, this.engine.sfxBus, (name, pitch, fft) => this.sound(name, pitch, fft));
    const ctx = this.engine.ctx;
    // Up-mixed to stereo first, so a mono song reaches both halves and
    // averages to itself, as FMOD reads a mono one's single channel. A
    // splitter's own interpretation is fixed at discrete.
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = "explicit";
    stereo.channelInterpretation = "speakers";
    const split = ctx.createChannelSplitter(2);
    this.mixer.mix.connect(stereo);
    stereo.connect(split);
    this.taps = [0, 1].map((ch) => {
      const tap = ctx.createAnalyser();
      tap.fftSize = this.samples.length;
      split.connect(tap, ch);
      return tap;
    });
  }

  /** Decodes the interface sounds. Cheap, and they are wanted immediately. */
  async loadUi(): Promise<void> {
    if (!this.library.codec) return;
    await this.library.preload(Object.values(UI_SOUNDS).map((n) => sfxPath(n, this.library.codec as "ogg")));
  }

  /**
   * Gets a level's sound ready before it starts, so the first of each does
   * not arrive a frame late: the effects its SFX triggers name, their
   * pitch-shifted copies, the level's own track decoded, and the songs its
   * Song triggers name fetched to decode when they are first played.
   * `track` is an online level's music, which the official tables do not
   * know; an official level leaves it out and its own is looked up.
   */
  async loadLevel(level: Level, levelId: number, track?: LevelTrack): Promise<void> {
    const codec = this.library.codec ?? "ogg";
    if (this.track) this.library.release(this.track);
    this.library.clearPrefetched();
    const chosen = track === undefined ? (this.strings.levelTrack(levelId) ?? null) : track;
    this.track = chosen && pathOf(chosen, codec);
    const script = chosen && "file" in chosen && !isMetered(chosen) ? this.strings.songPulse(chosen.index ?? -1) : undefined;
    this.script = script ? new ScriptPulse(script) : null;
    this.meter.enable();
    const levelAudio = new LevelAudio(level, levelId, this.track, this.mixer, this.sfxPlayer, codec);
    this.level = levelAudio;
    const jobs: Promise<unknown>[] = [];
    if (this.track) {
      this.library.retain(this.track);
      jobs.push(this.library.load(this.track));
    }
    if (this.library.codec) {
      const wanted = new Set<string>(LEVEL_EFFECTS);
      const shifted: Array<{ name: string; pitch: number; fft: boolean }> = [];
      for (const p of levelAudio.triggers) {
        if (p.id === 1934 && p.soundId > 0) this.library.prefetch(songPath(p.soundId, codec));
        // Only an SFX trigger names a sound; an Edit SFX's key 392 is not one.
        if (p.id !== 3602 || p.soundId <= 0) continue;
        wanted.add(triggerSfxName(p.soundId));
        if (p.pitch !== 1) shifted.push({ name: triggerSfxName(p.soundId), pitch: p.pitch, fft: p.fft2048 });
      }
      jobs.push(
        this.library.preload([...wanted].map((n) => sfxPath(n, codec))).then(() => {
          for (const s of shifted) this.shift(s.name, s.pitch, s.fft, codec);
        }),
      );
    }
    await Promise.all(jobs);
  }

  /** A fresh attempt; `musicTime` overrides where the music starts (the debug page's jump). */
  startAttempt(sim: Sim, practice: boolean, musicTime?: number): void {
    this.mixer.stop(MENU_CHANNEL);
    this.script?.restart();
    this.forSim(sim)?.startAttempt(sim, practice, musicTime);
  }

  /** Back at a checkpoint; `kept` is what Sim.respawnFrom returned. */
  respawn(sim: Sim, practice: boolean, kept: number): void {
    this.script?.restart();
    this.forSim(sim)?.respawn(sim, practice, kept);
  }

  /**
   * One frame of the music pulse, `dt` its length (0 while the level is held
   * still), and the pulse to draw with.
   * [gdp PlayLayer::updateVisibility :95866-95895]
   */
  pulse(dt: number, practice: boolean): number {
    const script = this.script;
    if (script) script.step(dt, practice);
    else this.meter.step(dt, () => this.peak());
    if (practice || this.engine.musicBus.gain.value <= 0) return PULSE_FLAT;
    return script ? script.value : this.meter.value;
  }

  /** The music's peak over the last block, both halves averaged. */
  private peak(): number {
    let sum = 0;
    for (const tap of this.taps) {
      tap.getFloatTimeDomainData(this.samples);
      let peak = 0;
      for (const v of this.samples) {
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      sum += peak;
    }
    return sum / this.taps.length;
  }

  /** The loaded level's sound, if the sim is on that level. */
  private forSim(sim: Sim): LevelAudio | null {
    return this.level && this.level.level === sim.level ? this.level : null;
  }

  enterPractice(): void {
    this.level?.enterPractice();
  }

  playerDied(sim: Sim, practice: boolean): void {
    this.forSim(sim)?.playerDied(sim, practice);
  }

  finishLevel(sim: Sim, practice: boolean): void {
    this.forSim(sim)?.finish(sim, practice);
  }

  /** The pause menu opens and closes. */
  pauseLevel(): void {
    this.engine.pauseGame();
  }

  resumeLevel(): void {
    this.engine.resumeGame();
  }

  /** Leaving the level: its sound stops. [gdp PlayLayer::onQuit :92414 → resetAudio → clearAllAudio] */
  stopLevel(): void {
    this.mixer.stopAll();
    this.sfxPlayer.stopAll();
    this.sfxPlayer.stopEffects();
  }

  /** Off silences only the main menu's loop; the other menus keep theirs. */
  private menuLoopOn = true;

  setMenuMusic(on: boolean): void {
    this.menuLoopOn = on;
    const menuPath = musicPath(MENU_MUSIC.menu);
    if (!on && this.mixer.playing(MENU_CHANNEL) === menuPath) this.mixer.stop(MENU_CHANNEL);
  }

  async playMenuMusic(which: keyof typeof MENU_MUSIC = "menu"): Promise<void> {
    if (which === "menu" && !this.menuLoopOn) return;
    const path = musicPath(MENU_MUSIC[which]);
    if (this.mixer.playing(MENU_CHANNEL) === path) return;
    this.mixer.start(MENU_CHANNEL, loopFromStart(path));
  }

  /** A soundtrack song on the menu channel, in place of the menu's loop. */
  playSong(file: string): void {
    const path = musicPath(file);
    if (this.mixer.playing(MENU_CHANNEL) === path) return;
    this.mixer.start(MENU_CHANNEL, loopFromStart(path));
  }

  /** Whether `file` is the song the menu channel is playing. */
  isPlayingSong(file: string): boolean {
    return this.mixer.playing(MENU_CHANNEL) === musicPath(file);
  }

  /** Back to the main menu's loop, or silence when that is turned off. */
  stopSong(): void {
    if (this.menuLoopOn) void this.playMenuMusic("menu");
    else this.mixer.stop(MENU_CHANNEL);
  }

  /** One frame: plays whatever the simulation did. `camera` is the view's centre, for proximity. */
  update(sim: Sim, camera?: readonly [number, number]): void {
    this.level?.update(sim, camera);
  }

  ui(sound: UiSound, volume = 1): void {
    this.sfxPlayer.ui(UI_SOUNDS[sound], volume);
  }

  setVolumes(settings: AudioSettings): void {
    this.engine.setVolumes(settings);
  }

  dispose(): void {
    this.mixer.stopAll();
    this.sfxPlayer.stopAll();
    this.sfxPlayer.stopEffects();
    this.engine.dispose();
  }

  /** A decoded sound for the players; one not loaded yet is fetched for next time. */
  private sound(name: string, pitch: number, fft2048: boolean): AudioBuffer | null {
    const codec = this.library.codec;
    if (!codec) return null;
    const path = sfxPath(name, codec);
    if (pitch !== 1) {
      const shifted = this.library.get(shiftedName(path, pitch, fft2048));
      if (shifted) return shifted;
    }
    const buffer = this.library.get(path);
    if (!buffer) void this.library.effect(path);
    return buffer;
  }

  /** Key 405's pitch-shifted copy of a decoded effect, made once. */
  private shift(name: string, pitch: number, fft2048: boolean, codec: "ogg" | "m4a"): void {
    const path = sfxPath(name, codec);
    const key = shiftedName(path, pitch, fft2048);
    const plain = this.library.get(path);
    if (!plain || this.library.get(key)) return;
    const input: Float32Array<ArrayBuffer>[] = [];
    for (let c = 0; c < plain.numberOfChannels; c++) input.push(plain.getChannelData(c));
    const out = pitchShift(input, pitch, fft2048 ? 2048 : 1024);
    const buffer = this.engine.ctx.createBuffer(plain.numberOfChannels, plain.length, plain.sampleRate);
    out.forEach((data, c) => buffer.copyToChannel(data, c));
    this.library.keep(key, buffer);
  }
}

/**
 * A level's music: an official track's file, with its song index when known,
 * or a custom song by id. Null is silence.
 */
export type LevelTrack = { file: string; index?: number } | { songId: number } | null;

function pathOf(track: { file: string } | { songId: number }, codec: "ogg" | "m4a"): string {
  return "file" in track ? musicPath(track.file) : songPath(track.songId, codec);
}

function shiftedName(path: string, pitch: number, fft2048: boolean): string {
  return `${path}#${pitch}${fft2048 ? "/2048" : ""}`;
}
