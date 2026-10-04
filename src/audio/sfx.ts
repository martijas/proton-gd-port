// Sound effects: the level's SFX triggers, and the one-shots outside them.
//
// A trigger's sound is a voice LevelAudio numbers, so an Edit SFX can reach
// it later: its speed and volume tween, a proximity factor turns it up or
// down, and a stop ends it now or at the end of its loop. A sound in an SFX
// group (key 455) plays through that group's bus, whose volume and speed an
// Edit SFX can change for everything in it, including what starts later.
// [gdp FMODAudioEngine::playEffectAdvanced :73942-74280, the group's channel
//  group :74098; updateChannel :70808-70890 (the group maps +596, +652)]
//
//   source → fade → volume → proximity → group (volume → proximity) → sfx bus
//
// A sound whose trigger sets key 407 goes into the reverb instead of straight
// to the bus, its group's included (a group keeps a second branch for these,
// as the game keeps a second channel group): the reverb passes it on dry and
// adds the preset's tail (reverb.ts).
// [gdp FMODAudioEngine::getChannelGroup :68395-68456 (+404 for reverb, else
//  +400; the per-group maps +1140 and +1112), from playEffectAdvanced :74098;
//  the reverb DSP on +404, init :64152-64154]
//
// Two caps, both the port's own, so that a stuck trigger cannot drown the
// level: twenty-four voices in total, oldest stolen first, and four of any one
// sound.
//
// The one-shots outside the triggers are not voices. A level's (a death, a
// finish) are kept until they end, so a reset can cut them; an interface
// sound plays out whatever happens.

import type { SfxOut, VoicePlay } from "./levelAudio";
import { ramp } from "./music";
import { reverbImpulse, reverbPreset, REVERB_PRESETS } from "./reverb";

/** Finds a decoded sound, pitch-shifted when asked; null when it is not there yet. */
export type SoundLookup = (name: string, pitch: number, fft2048: boolean) => AudioBuffer | null;

interface Voice {
  id: number;
  name: string;
  group: number;
  source: AudioBufferSourceNode;
  fade: GainNode;
  volume: GainNode;
  mod: GainNode;
  /** Its own speed; its group's multiplies it. */
  rate: number;
}

interface Group {
  gain: GainNode;
  mod: GainNode;
  /** The branch its key-407 sounds take, into the reverb; made when first wanted. */
  wet: { gain: GainNode; mod: GainNode } | null;
  speed: number;
}

const MAX_VOICES = 24;
const MAX_PER_SOUND = 4;

export class SfxPlayer implements SfxOut {
  private readonly voices = new Map<number, Voice>();
  private readonly groups = new Map<number, Group>();
  /** The level's one-shots still sounding. */
  private readonly effects = new Set<AudioBufferSourceNode>();
  /** The reverb's input and its convolver, made with the first sound that wants them. */
  private reverb: { input: GainNode; convolver: ConvolverNode } | null = null;
  /** The preset in force, 0 for Generic. */
  private preset = 0;
  private readonly impulses = new Map<number, AudioBuffer>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly bus: AudioNode,
    private readonly lookup: SoundLookup,
  ) {}

  play(id: number, v: VoicePlay): void {
    const buffer = this.lookup(v.name, v.pitch, v.fft2048);
    if (!buffer) return;
    this.stop(id, false);
    const length = buffer.duration * 1000;
    let at = Math.max(0, v.offsetMs);
    const loopStart = v.loopStartMs > 0 ? v.loopStartMs : 0;
    const loopEnd = v.loopEndMs > 0 ? Math.min(v.loopEndMs, length) : length;
    if (v.loop) {
      if (loopEnd > loopStart && at >= loopEnd) at = loopStart + ((at - loopStart) % (loopEnd - loopStart));
    } else if (at >= (v.endMs > 0 ? Math.min(v.endMs, length) : length)) {
      return;
    }

    const same = [...this.voices.values()].filter((o) => o.name === v.name);
    if (same.length >= MAX_PER_SOUND) this.retire(same[0]);
    if (this.voices.size >= MAX_VOICES) this.retire(this.voices.values().next().value as Voice);

    const now = this.ctx.currentTime;
    const group = v.group > 0 ? this.group(v.group) : null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const rate = v.rate > 0 ? v.rate : 1;
    source.playbackRate.value = rate * (group?.speed ?? 1);
    source.loop = v.loop;
    if (v.loop && (v.loopStartMs > 0 || v.loopEndMs > 0)) {
      source.loopStart = loopStart / 1000;
      source.loopEnd = loopEnd / 1000;
    }
    const fade = this.ctx.createGain();
    const volume = this.ctx.createGain();
    const mod = this.ctx.createGain();
    volume.gain.value = v.volume;
    const into = group ? (v.reverb ? this.wetBranch(group).gain : group.gain) : v.reverb ? this.reverbInput() : this.bus;
    source.connect(fade).connect(volume).connect(mod).connect(into);
    if (v.fadeInMs > v.fadeInDoneMs) {
      fade.gain.setValueAtTime(v.fadeInDoneMs / v.fadeInMs, now);
      fade.gain.linearRampToValueAtTime(1, now + (v.fadeInMs - v.fadeInDoneMs) / 1000);
    }
    source.start(now, at / 1000);
    if (!v.loop) {
      // The stop and the fade before it are on the clock at the speed it
      // starts with, as FMOD's delay and fade points are. [:74121-74170]
      const stopMs = v.endMs > 0 ? Math.min(v.endMs, length) : length;
      const left = (stopMs - at) / (rate * (group?.speed ?? 1)) / 1000;
      if (v.endMs > 0) source.stop(now + left);
      if (v.fadeOutMs > 0) {
        fade.gain.setValueAtTime(1, Math.max(now, now + left - v.fadeOutMs / 1000));
        fade.gain.linearRampToValueAtTime(0, now + left);
      }
    }
    const voice: Voice = { id, name: v.name, group: v.group, source, fade, volume, mod, rate };
    this.voices.set(id, voice);
    source.onended = () => {
      if (this.voices.get(id) === voice) this.forget(voice);
    };
  }

  stop(id: number, afterLoop: boolean): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    // Letting the loop go plays the rest of the sound out.
    if (afterLoop) voice.source.loop = false;
    else this.retire(voice);
  }

  volume(id: number, to: number, over: number): void {
    const voice = this.voices.get(id);
    if (voice) ramp(this.ctx, voice.volume.gain, to, over);
  }

  speed(id: number, to: number, over: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.rate = to;
    ramp(this.ctx, voice.source.playbackRate, to * (this.groups.get(voice.group)?.speed ?? 1), over);
  }

  volumeMod(id: number, mod: number): void {
    const voice = this.voices.get(id);
    if (voice) voice.mod.gain.setValueAtTime(mod, this.ctx.currentTime);
  }

  groupVolume(group: number, to: number, over: number): void {
    const g = this.group(group);
    ramp(this.ctx, g.gain.gain, to, over);
    if (g.wet) ramp(this.ctx, g.wet.gain.gain, to, over);
  }

  /** A group's speed multiplies each of its voices' own. [Q14: taken as FMOD channel-group pitch] */
  groupSpeed(group: number, to: number, over: number): void {
    const g = this.group(group);
    g.speed = to;
    for (const voice of this.voices.values()) {
      if (voice.group === group) ramp(this.ctx, voice.source.playbackRate, voice.rate * to, over);
    }
  }

  groupVolumeMod(group: number, mod: number): void {
    const g = this.group(group);
    g.mod.gain.setValueAtTime(mod, this.ctx.currentTime);
    if (g.wet) g.wet.mod.gain.setValueAtTime(mod, this.ctx.currentTime);
  }

  /**
   * The reverb's preset. Sounds already in it change with it, as the one
   * DSP they share does; the same preset again changes nothing.
   * [gdp FMODAudioEngine::updateReverb :64019-64070]
   */
  reverbPreset(preset: number): void {
    const n = preset >= 1 && preset <= REVERB_PRESETS.length ? preset : 0;
    if (n === this.preset) return;
    this.preset = n;
    if (this.reverb) this.reverb.convolver.buffer = this.impulse(n);
  }

  /** Every trigger voice, and the groups' settings with them. */
  stopAll(): void {
    for (const voice of [...this.voices.values()]) this.retire(voice);
    for (const g of this.groups.values()) {
      g.gain.disconnect();
      g.mod.disconnect();
      g.wet?.gain.disconnect();
      g.wet?.mod.disconnect();
    }
    this.groups.clear();
  }

  effect(name: string, volume: number): void {
    const source = this.oneShot(name, volume);
    if (source) this.effects.add(source);
  }

  /**
   * The level's one-shots, cut, as a reset stops the channel group they play
   * in; the trigger voices are stopAll's.
   * [gdp FMODAudioEngine::stopAllEffects :66708-66722 stops +400, the group
   *  playEffect's sounds play in (playEffect :74517-74524 → playEffectAdvanced
   *  with no group; getChannelGroup :68446-68453)]
   */
  stopEffects(): void {
    for (const source of this.effects) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.effects.clear();
  }

  /** An interface sound: nothing here cuts it. */
  ui(name: string, volume = 1): void {
    this.oneShot(name, volume);
  }

  lengthMs(name: string): number {
    const buffer = this.lookup(name, 1, false);
    return buffer ? buffer.duration * 1000 : 0;
  }

  playing(id: number): boolean {
    return this.voices.has(id);
  }

  private oneShot(name: string, volume: number): AudioBufferSourceNode | null {
    const buffer = this.lookup(name, 1, false);
    if (!buffer) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(this.bus);
    source.onended = () => {
      this.effects.delete(source);
      source.disconnect();
      gain.disconnect();
    };
    source.start();
    return source;
  }

  private group(id: number): Group {
    let g = this.groups.get(id);
    if (!g) {
      const gain = this.ctx.createGain();
      const mod = this.ctx.createGain();
      gain.connect(mod).connect(this.bus);
      g = { gain, mod, wet: null, speed: 1 };
      this.groups.set(id, g);
    }
    return g;
  }

  /** A group's branch into the reverb, at the group's volume and proximity now. */
  private wetBranch(g: Group): { gain: GainNode; mod: GainNode } {
    if (!g.wet) {
      const gain = this.ctx.createGain();
      const mod = this.ctx.createGain();
      gain.gain.value = g.gain.gain.value;
      mod.gain.value = g.mod.gain.value;
      gain.connect(mod).connect(this.reverbInput());
      g.wet = { gain, mod };
    }
    return g.wet;
  }

  /** The reverb: its input goes to the bus dry, at 0 dB, and through the preset's impulse. */
  private reverbInput(): GainNode {
    if (!this.reverb) {
      const input = this.ctx.createGain();
      const convolver = this.ctx.createConvolver();
      convolver.normalize = false;
      convolver.buffer = this.impulse(this.preset);
      input.connect(this.bus);
      input.connect(convolver).connect(this.bus);
      this.reverb = { input, convolver };
    }
    return this.reverb.input;
  }

  private impulse(preset: number): AudioBuffer {
    let buffer = this.impulses.get(preset);
    if (!buffer) {
      const rate = this.ctx.sampleRate;
      const [left, right] = reverbImpulse(reverbPreset(preset), rate, preset + 1);
      buffer = this.ctx.createBuffer(2, left.length, rate);
      buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
      buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
      this.impulses.set(preset, buffer);
    }
    return buffer;
  }

  private retire(voice: Voice): void {
    try {
      voice.source.stop();
    } catch {
      // Already finished.
    }
    this.forget(voice);
  }

  private forget(voice: Voice): void {
    if (this.voices.get(voice.id) === voice) this.voices.delete(voice.id);
    voice.source.disconnect();
    voice.fade.disconnect();
    voice.volume.disconnect();
    voice.mod.disconnect();
  }
}
