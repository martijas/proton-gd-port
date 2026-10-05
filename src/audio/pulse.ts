// The music pulse: the one number the orbs, the pulsing decorations and the
// wave's band all scale with.
//
// The game has two sources for it and a level uses one. A custom song, or one
// of the newer official tracks, is metered: FMOD reports the music's peak
// level and the engine turns that into beats. The older official tracks are
// not listened to at all — each has a beat script compiled into the game, a
// list of times and strengths, and AudioEffectsLayer plays it from the start
// of every attempt. Practice holds the pulse at 0.5, and so does a game with
// the music turned off.
// [gdp PlayLayer::init :106266-106285 (enableMetering, +11884, +11804,
//  AudioEffectsLayer::create); PlayLayer::updateVisibility :95866-95895]

/** What the pulse settles back to between beats. */
export const PULSE_REST = 0.1;
/** The pulse when there is nothing to follow: practice, the music off, the menus. [updateVisibility :95877-95889; MenuGameLayer::init :237864] */
export const PULSE_FLAT = 0.5;

/** The newest official track the game still pulses with a script; later ones are metered. [PlayLayer::init :106269] */
const LAST_SCRIPTED_SONG = 19;

/** Whether a level's music is metered rather than scripted. */
export function isMetered(track: { songId?: number; index?: number } | null | undefined): boolean {
  if (!track) return true;
  if ((track.songId ?? 0) > 0) return true;
  return track.index === undefined || track.index > LAST_SCRIPTED_SONG;
}

/**
 * The metered pulse. The engine samples the music's peak at most sixty times
 * a second: the peak, plus 0.1, is a beat when it is a tenth up on the last
 * value, at least three samples on from the last beat, and near that beat's
 * height (or the pulse has fallen well below it); a beat jumps to a tenth
 * over the peak, and anything else lets the pulse fall by 7% a sample.
 * [gdp FMODAudioEngine::update :74799-74820 (the sixtieth),
 *  FMODAudioEngine::updateMetering → sub_2F35E8 :62965-63010,
 *  enableMetering :64576-64583]
 */
export class MeterPulse {
  value = PULSE_REST;
  private last = 0;
  private sinceBeat = 0;
  private due = 0;

  /** As enableMetering leaves it, for a level that has just loaded. */
  enable(): void {
    this.value = PULSE_REST;
    this.last = 0;
    this.due = 0;
  }

  /** Advances the clock; `peak` is read only when a sample is due. */
  step(dt: number, peak: () => number): void {
    this.due += dt;
    if (this.due < 1 / 60) return;
    this.due = 0;
    this.sample(peak());
  }

  /** One sample of the music's peak level, 0..1, before the music volume. */
  sample(peak: number): void {
    const level = Math.fround(peak + 0.1);
    const prev = this.value;
    let next: number;
    if (
      this.sinceBeat > 2 &&
      level >= Math.fround(prev * 1.1) &&
      (level >= Math.fround(this.last * 0.95) || prev <= Math.fround(this.last * 0.2))
    ) {
      this.last = level;
      this.sinceBeat = 0;
      next = Math.fround(level * 1.1);
    } else {
      next = Math.fround(prev * 0.93);
    }
    this.value = next;
    if (next <= PULSE_REST) this.last = 0;
    this.sinceBeat++;
  }
}

/** How long a scripted beat takes to rise, and to fall back to rest. [AudioEffectsLayer::triggerEffect :329735-329745] */
const RISE = 0.05;
const FALL = 0.2;
/** The highest a scripted beat reaches. [:329728-329729] */
const SCRIPT_PEAK = Math.fround(1.1);

/**
 * The scripted pulse. Each entry's strength is read as a step — 1.0 as 4,
 * 0.9 as 3, 0.8 as 2.5, anything else as itself — and a fifth of it is added
 * to where the pulse is, up to 1.1. The pulse rises there over 0.05 s and
 * falls back to rest over 0.2 s; a new beat only cuts in once the last has
 * started falling, or when it would go higher. One entry is taken a frame, and
 * none in practice. A new attempt starts the script again, but a beat in
 * flight runs on.
 * [gdp AudioEffectsLayer::audioStep :329769-329799, triggerEffect
 *  :329701-329753, goingDown :329365-329368, resetAudioVars :329531-329549,
 *  init :329626 (rest); PlayLayer::update :105304-105305, resetLevel :105891]
 */
export class ScriptPulse {
  value = PULSE_REST;
  private time = 0;
  private next = 0;
  private target = 0;
  private falling = false;
  /** The beat in flight: where it started, how high it goes, how far in it is; `at` < 0 for none. */
  private from = PULSE_REST;
  private to = PULSE_REST;
  private at = -1;

  constructor(private readonly script: readonly number[]) {}

  /** A new attempt: the script from its start. */
  restart(): void {
    this.time = 0;
    this.next = 0;
  }

  step(dt: number, practice: boolean): void {
    this.time += dt;
    const s = this.script;
    if (this.next + 1 < s.length && s[this.next] < this.time) {
      const strength = s[this.next + 1];
      this.next += 2;
      if (!practice) this.beat(strength);
    }
    this.advance(dt);
  }

  private beat(strength: number): void {
    const f = Math.fround(strength);
    const step = f === Math.fround(1) ? 4 : f === Math.fround(0.9) ? 3 : f === Math.fround(0.8) ? 2.5 : f;
    let to = Math.fround(this.value + Math.fround(step * 0.2));
    if (to >= SCRIPT_PEAK) to = SCRIPT_PEAK;
    if (!this.falling && this.target > to) return;
    this.target = to;
    this.falling = false;
    this.from = this.value;
    this.to = to;
    this.at = 0;
  }

  private advance(dt: number): void {
    if (this.at < 0) return;
    this.at += dt;
    if (this.at < RISE) {
      this.value = this.from + (this.to - this.from) * (this.at / RISE);
      return;
    }
    this.falling = true;
    if (this.at < RISE + FALL) {
      this.value = this.to + (PULSE_REST - this.to) * ((this.at - RISE) / FALL);
      return;
    }
    this.value = PULSE_REST;
    this.at = -1;
  }
}

/**
 * How big a pulsing object is drawn for a pulse, before its own scale. An orb
 * stands 0.3 over the pulse, up to 1.2; the pulsing decorations that keep a
 * range of their own run 0.8 to 1.2; the rest take the pulse as it is.
 * [gdp PlayLayer::updateVisibility :96000-96009 (setRScale, +910's range);
 *  RingObject::setRScale :298067-298077; GameObject::customSetup :178766-178771,
 *  :179880-179888, :182326-182336 (the 0.8-1.2 range)]
 */
export function pulseScale(kind: "ring" | "ranged" | "plain", pulse: number): number {
  if (kind === "ring") {
    const k = Math.fround(pulse + 0.3);
    return k < Math.fround(1.2) ? k : Math.fround(1.2);
  }
  if (kind === "ranged") return Math.fround(0.8 + Math.fround(Math.fround(pulse - 0.1) * Math.fround(1.2 - 0.8)));
  return pulse;
}
