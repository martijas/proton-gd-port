// Where a song is, and how loud, at a given music time: the pure half of the
// game's checkpoint replay, in its own float steps.

const f = Math.fround;

/** A timed change: to `to`, over `over` seconds, from music time `at`. */
export interface TimedChange {
  at: number;
  to: number;
  over: number;
}

/**
 * The ms FMOD is seeked to for a song started at `t0` and heard at `now`, with
 * no speed edits: float steps and an int cut, then the loop's wrap when it has
 * an end. [gdp GJBaseGameLayer::processSongState, gd-ida-decomp.cpp:432553-432797]
 */
export function songPositionMs(startMs: number, t0: number, now: number, speed: number, loop: boolean, endMs: number): number {
  const elapsed = f(f(now) - f(t0));
  let ms = Math.trunc(f(f(startMs) + f(f(elapsed * speed) * 1000)));
  if (loop && endMs > startMs) ms = ((ms - startMs) % (endMs - startMs)) + startMs;
  return ms;
}

/**
 * Where the level's own track is at music time `now`, in ms: kA13 plus the
 * clock, as the replay seeks it. [gdp processActivatedAudioTriggers
 * :454908-454962 → processSongState :432553-432797 with no trigger]
 */
export function levelSongPositionMs(kA13: number, now: number): number {
  return songPositionMs(Math.trunc(f(f(kA13) * 1000)), 0, now, 1, false, 0);
}

/**
 * A value changed by timed edits, at `now`: where it is, where it is heading,
 * and the seconds of tween left. Each edit starts from wherever the one
 * before had got to when it arrived.
 * [gdp processSongState :432665-432676 (the walk), 432752-432771 (now)]
 */
export function tweenAt(base: number, edits: readonly TimedChange[], now: number): [number, number, number] {
  let value = f(base);
  let prev: TimedChange | null = null;
  for (const e of edits) {
    if (prev) {
      const d = f(prev.over);
      const gap = f(f(e.at) - f(prev.at));
      value = d <= 0 || d <= gap ? f(prev.to) : f(value + f(f(f(prev.to) - value) * f(gap / d)));
    }
    prev = e;
  }
  if (!prev) return [value, value, 0];
  const d = f(prev.over);
  const elapsed = f(f(now) - f(prev.at));
  if (d <= 0 || d <= elapsed) return [f(prev.to), f(prev.to), 0];
  return [f(value + f(f(f(prev.to) - value) * f(elapsed / d))), f(prev.to), f(d - elapsed)];
}

/** An Edit Song as the replay reads it. */
export interface SongEdit {
  at: number;
  changeSpeed: boolean;
  changeVolume: boolean;
  /** pitchForIdx(404), and 406. */
  speed: number;
  volume: number;
  /** Key 10. */
  duration: number;
}

export interface SongStateAt {
  /** File ms before any loop wrap. */
  positionMs: number;
  speed: number;
  speedTarget: number;
  speedLeft: number;
  volume: number;
  volumeTarget: number;
  volumeLeft: number;
}

/**
 * processSongState whole: a song started at `t0` (music time) from `startMs`,
 * at `speed` and `volume`, and the Edit Songs on its channel since — the ones
 * before `t0` belonged to whatever played there earlier. Speed edits are
 * integrated by the average of each ramp's ends, as the game does; no official
 * Edit Song changes speed. A stop never reaches this: an Edit Song with key 417
 * clears the channel's song when it is noted.
 * [gdp GJBaseGameLayer::processSongState :432553-432797;
 *  activatedAudioTrigger :447941-447960]
 */
export function songState(startMs: number, t0: number, now: number, speed: number, volume: number, edits: readonly SongEdit[]): SongStateAt {
  const start = f(t0);
  const mine = edits.filter((e) => !(e.at < start));
  let pos = startMs;
  let s = f(speed);
  let prev: SongEdit | null = null;
  for (const e of mine) {
    if (!e.changeSpeed) continue;
    if (prev) {
      let span = f(prev.duration);
      const gap = f(f(e.at) - f(prev.at));
      let rest = f(gap - span);
      let reached = prev.speed;
      if (span > 0) {
        if (span > gap) {
          reached = f(s + f(f(prev.speed - s) * f(gap / span)));
          span = gap;
          rest = 0;
        }
        pos = Math.trunc(f(f(pos) + f(f(span * f(f(s + reached) * 0.5)) * 1000)));
      }
      s = reached;
      if (rest > 0) pos = Math.trunc(f(f(pos) + f(f(rest * reached) * 1000)));
    } else {
      pos = Math.trunc(f(f(pos) + f(f(f(f(e.at) - start) * s) * 1000)));
    }
    prev = e;
  }
  let speedTarget = s;
  let speedLeft = 0;
  if (prev) {
    const span = f(prev.duration);
    const elapsed = f(f(now) - f(prev.at));
    const rest = f(elapsed - span);
    speedTarget = prev.speed;
    if (span <= 0) {
      s = prev.speed;
      if (rest > 0) pos = Math.trunc(f(f(pos) + f(f(rest * s) * 1000)));
    } else {
      const before = s;
      const done = span <= elapsed;
      if (done) s = prev.speed;
      else {
        speedLeft = f(span - elapsed);
        s = f(s + f(f(prev.speed - s) * f(elapsed / span)));
      }
      pos = Math.trunc(f(f(pos) + f(f((done ? span : elapsed) * f(f(before + s) * 0.5)) * 1000)));
      if (done && rest > 0) pos = Math.trunc(f(f(pos) + f(f(rest * s) * 1000)));
    }
  } else {
    pos = Math.trunc(f(f(pos) + f(f(f(f(now) - start) * s) * 1000)));
  }
  const [v, vTarget, vLeft] = tweenAt(
    volume,
    mine.filter((e) => e.changeVolume).map((e) => ({ at: e.at, to: e.volume, over: e.duration })),
    now,
  );
  return { positionMs: pos, speed: s, speedTarget, speedLeft, volume: v, volumeTarget: vTarget, volumeLeft: vLeft };
}
