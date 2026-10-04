// The level's music: numbered channels, as the game's audio engine has them.
//
// Channel 0 carries the level's own track, or the practice track, or a Song
// trigger's song; a Song trigger can put more on channels of its own (key
// 432), which play alongside. Each channel is a source started once at the
// right offset and then left alone — the game does the same, and a 240 Hz
// simulation and a 48 kHz audio clock drift by well under a frame over a
// three-minute level, while re-seeking every tick would be audible every
// tick. What changes live is what the game's engine changes live: volume and
// speed tweens, the proximity factor, fades and the end of a loop. The time
// warp is not among them: it changes how fast the game runs, never the music.
//
//   source → fade → volume → proximity ─┐
//   source → fade → volume → proximity ─┼→ level gain → music bus
//                                        …

import type { ChannelPlay, MusicOut } from "./levelAudio";

/** Where the mixer gets decoded songs, and tells it which it still needs. */
export interface MusicSource {
  get(path: string): AudioBuffer | null;
  load(path: string): Promise<AudioBuffer | null>;
  retain(path: string): void;
  release(path: string): void;
}

interface Voice {
  path: string;
  play: ChannelPlay;
  source: AudioBufferSourceNode | null;
  fade: GainNode;
  volume: GainNode;
  mod: GainNode;
  /** The speed it is heading for, for a start still waiting on its decode. */
  rate: number;
  asked: number;
  done: boolean;
  /** Silenced by a death: its song stays held until the next start or stop. */
  paused: boolean;
}

export class MusicMixer implements MusicOut {
  private readonly out: GainNode;
  private readonly voices = new Map<number, Voice>();
  /** The proximity factor per channel, which a new song on it keeps. */
  private readonly mods = new Map<number, number>();
  private readonly prepared = new Set<string>();

  constructor(
    private readonly ctx: BaseAudioContext,
    bus: AudioNode,
    private readonly songs: MusicSource,
  ) {
    this.out = ctx.createGain();
    this.out.connect(bus);
  }

  start(channel: number, play: ChannelPlay): void {
    this.stop(channel);
    const fade = this.ctx.createGain();
    const volume = this.ctx.createGain();
    const mod = this.ctx.createGain();
    fade.connect(volume).connect(mod).connect(this.out);
    volume.gain.value = play.volume;
    mod.gain.value = this.mods.get(channel) ?? 1;
    const voice: Voice = { path: play.path, play, source: null, fade, volume, mod, rate: play.rate, asked: this.ctx.currentTime, done: false, paused: false };
    this.voices.set(channel, voice);
    this.songs.retain(play.path);
    const buffer = this.songs.get(play.path);
    if (buffer) {
      this.begin(channel, voice, buffer);
      return;
    }
    void this.songs.load(play.path).then((b) => {
      if (b && this.voices.get(channel) === voice && !voice.paused) this.begin(channel, voice, b);
    });
  }

  private begin(channel: number, voice: Voice, buffer: AudioBuffer): void {
    const play = voice.play;
    const now = this.ctx.currentTime;
    const length = buffer.duration * 1000;
    // A start kept to the music clock that waited for its decode is that much
    // further in by now; a track looped from its start starts at its start.
    let at = play.positionMs + (play.synced ? (now - voice.asked) * 1000 * play.rate : 0);
    const loopStart = play.loopStartMs > 0 ? play.loopStartMs : 0;
    const loopEnd = play.loopEndMs > 0 ? Math.min(play.loopEndMs, length) : length;
    if (play.loop) {
      // A looping song seeked past its end wraps by the loop.
      if (loopEnd > loopStart && at >= loopEnd) at = loopStart + ((at - loopStart) % (loopEnd - loopStart));
    } else if (at >= (play.endMs > 0 ? play.endMs : length)) {
      this.forget(channel, voice);
      return;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = voice.rate;
    source.loop = play.loop;
    if (play.loop && (play.loopStartMs > 0 || play.loopEndMs > 0)) {
      source.loopStart = loopStart / 1000;
      source.loopEnd = loopEnd / 1000;
    }
    source.connect(voice.fade);
    if (play.fadeInMs > 0) {
      voice.fade.gain.setValueAtTime(0, now);
      voice.fade.gain.linearRampToValueAtTime(1, now + play.fadeInMs / 1000);
    }
    source.start(now, at / 1000);
    if (!play.loop) {
      // The end and the fade before it are timed at the rate it starts with,
      // as FMOD's delay and fade points are. [FMODAudioEngine::startMusic :70721-70771]
      const stopMs = play.endMs > 0 ? play.endMs : length;
      const left = (stopMs - at) / voice.rate / 1000;
      if (play.endMs > 0) source.stop(now + left);
      if (play.fadeOutMs > 0) {
        const from = Math.max(now, now + left - play.fadeOutMs / 1000);
        voice.fade.gain.setValueAtTime(1, from);
        voice.fade.gain.linearRampToValueAtTime(0, now + left);
      }
    }
    source.onended = () => {
      if (this.voices.get(channel) === voice) this.forget(channel, voice);
    };
    voice.source = source;
  }

  stop(channel: number): void {
    const voice = this.voices.get(channel);
    if (voice) this.forget(channel, voice);
  }

  stopAll(): void {
    for (const [channel, voice] of [...this.voices]) this.forget(channel, voice);
    this.mods.clear();
    for (const path of this.prepared) this.songs.release(path);
    this.prepared.clear();
  }

  /**
   * Every channel goes quiet but keeps its song, and the prepared songs stay
   * too, so the respawn after a death does not decode them again. Nothing
   * resumes a paused channel: the next start replaces it.
   * [gdp PlayLayer::destroyPlayer :93285-93289 → FMODAudioEngine::pauseAllMusic
   *  :68945-68958]
   */
  pauseAll(): void {
    for (const voice of this.voices.values()) {
      voice.paused = true;
      const source = voice.source;
      if (!source) continue;
      voice.source = null;
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
  }

  endLoop(channel: number): void {
    const voice = this.voices.get(channel);
    if (!voice) return;
    voice.play = { ...voice.play, loop: false };
    if (voice.source) voice.source.loop = false;
  }

  volume(channel: number, to: number, over: number): void {
    const voice = this.voices.get(channel);
    if (voice) ramp(this.ctx, voice.volume.gain, to, over);
  }

  speed(channel: number, to: number, over: number): void {
    const voice = this.voices.get(channel);
    if (!voice) return;
    voice.rate = to;
    if (voice.source) ramp(this.ctx, voice.source.playbackRate, to, over);
  }

  volumeMod(channel: number, mod: number): void {
    this.mods.set(channel, mod);
    const voice = this.voices.get(channel);
    if (voice) voice.mod.gain.setValueAtTime(mod, this.ctx.currentTime);
  }

  fadeIn(channel: number, seconds: number): void {
    const voice = this.voices.get(channel);
    if (!voice) return;
    const now = this.ctx.currentTime;
    voice.fade.gain.cancelScheduledValues(now);
    voice.fade.gain.setValueAtTime(0, now);
    voice.fade.gain.linearRampToValueAtTime(1, now + seconds);
  }

  fadeOut(channel: number, seconds: number): void {
    const voice = this.voices.get(channel);
    if (!voice) return;
    ramp(this.ctx, voice.fade.gain, 0, seconds);
    voice.source?.stop(this.ctx.currentTime + seconds + 0.02);
  }

  busFadeIn(seconds: number): void {
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(1, now + seconds);
  }

  prepare(path: string): void {
    if (this.prepared.has(path)) return;
    this.prepared.add(path);
    this.songs.retain(path);
    void this.songs.load(path);
  }

  playing(channel: number): string | null {
    return this.voices.get(channel)?.path ?? null;
  }

  private forget(channel: number, voice: Voice): void {
    if (voice.done) return;
    voice.done = true;
    if (this.voices.get(channel) === voice) this.voices.delete(channel);
    try {
      voice.source?.stop();
    } catch {
      // Already stopped; a source can only be started and stopped once.
    }
    voice.source?.disconnect();
    voice.fade.disconnect();
    voice.volume.disconnect();
    voice.mod.disconnect();
    this.songs.release(voice.path);
  }
}

/**
 * A value to `to`: at once, or in a straight line over `over` seconds from
 * where it is, replacing a tween already running on it.
 * [gdp FMODAudioEngine::updateChannel :70808-70890]
 */
export function ramp(ctx: BaseAudioContext, param: AudioParam, to: number, over: number): void {
  const now = ctx.currentTime;
  const from = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  if (over > 0) param.linearRampToValueAtTime(to, now + over);
  else param.setValueAtTime(to, now);
}
