// The one easing curve every timed trigger uses.
//
// Move, rotate, scale, keyframe, zoom and the camera tweens all call a single
// function in the game, so there is one table here and everything shares it.
// The eighteen modes are the cocos2d CCEase family, and the "rate" doubles as
// the exponent for the In/Out modes and as the *period* for the three elastic
// ones — which is why a single rate parameter can look so different between
// modes. [gdp GameToolbox::getEasedValue, gd-ida-decomp.cpp:44226-44426]

/** Editor order, which is also the value stored in key 30. */
export const EASING_NAMES: readonly string[] = [
  "None",
  "Ease In Out",
  "Ease In",
  "Ease Out",
  "Elastic In Out",
  "Elastic In",
  "Elastic Out",
  "Bounce In Out",
  "Bounce In",
  "Bounce Out",
  "Exponential In Out",
  "Exponential In",
  "Exponential Out",
  "Sine In Out",
  "Sine In",
  "Sine Out",
  "Back In Out",
  "Back In",
  "Back Out",
];

/** A rate of zero or less is not "instant", it is the default exponent. [gdp :44255-44262] */
const DEFAULT_RATE = 2;
/** CCEaseBack's overshoot constant, and the one the In/Out pair scales by 1.525. */
const BACK = 1.70158;
const BACK_IN_OUT = BACK * 1.525;

/**
 * cocos2d's bounce curve. The thresholds are compared in double precision in
 * the game because the float argument is widened first, so they are written out
 * as divisions rather than as the rounded literals the decompile prints.
 * [gdp GameToolbox::bounceTime :44171-44208]
 */
export function bounceTime(x: number): number {
  if (x < 1 / 2.75) return 7.5625 * x * x;
  if (x < 2 / 2.75) {
    const y = x - 1.5 / 2.75;
    return 7.5625 * y * y + 0.75;
  }
  if (x < 2.5 / 2.75) {
    const y = x - 2.25 / 2.75;
    return 7.5625 * y * y + 0.9375;
  }
  const y = x - 2.625 / 2.75;
  return 7.5625 * y * y + 0.984375;
}

/**
 * `t` is progress in 0..1, `type` is the editor's mode number and `rate` is its
 * rate field. Mode 0, and anything outside 1..18, is linear.
 */
export function easedValue(t: number, type: number, rate: number): number {
  if (type === 0 || type < 0 || type > 18) return t;
  const r = rate <= 0 ? DEFAULT_RATE : rate;
  switch (type) {
    case 1: {
      const u = 2 * t;
      return u < 1 ? 0.5 * Math.pow(u, r) : 1 - 0.5 * Math.pow(2 - u, r);
    }
    case 2:
      return Math.pow(t, r);
    case 3:
      return Math.pow(t, 1 / r);
    case 4: {
      if (t === 0 || t === 1) return t;
      const u = 2 * t - 1;
      const s = r * 0.25;
      const wave = Math.sin((2 * Math.PI * (u - s)) / r);
      return u < 0 ? -0.5 * Math.pow(2, 10 * u) * wave : 0.5 * Math.pow(2, -10 * u) * wave + 1;
    }
    case 5: {
      if (t === 0 || t === 1) return t;
      const u = t - 1;
      return -(Math.pow(2, 10 * u) * Math.sin((2 * Math.PI * (u - r * 0.25)) / r));
    }
    case 6: {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -10 * t) * Math.sin((2 * Math.PI * (t - r * 0.25)) / r) + 1;
    }
    case 7:
      return t < 0.5 ? 0.5 * (1 - bounceTime(1 - 2 * t)) : 0.5 * bounceTime(2 * t - 1) + 0.5;
    case 8:
      return 1 - bounceTime(1 - t);
    case 9:
      return bounceTime(t);
    case 10: {
      const u = 2 * t - 1;
      return 0.5 * (u < 0 ? Math.pow(2, 10 * u) : 2 - Math.pow(2, -10 * u));
    }
    case 11:
      return t === 0 ? 0 : Math.pow(2, 10 * (t - 1)) - 0.001;
    case 12:
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    case 13:
      return -0.5 * (Math.cos(Math.PI * t) - 1);
    case 14:
      return 1 - Math.cos((t * Math.PI) / 2);
    case 15:
      return Math.sin((t * Math.PI) / 2);
    case 16: {
      const u = 2 * t;
      if (u < 1) return 0.5 * u * u * ((BACK_IN_OUT + 1) * u - BACK_IN_OUT);
      const w = u - 2;
      return 1 + 0.5 * w * w * ((BACK_IN_OUT + 1) * w + BACK_IN_OUT);
    }
    case 17:
      return t * t * ((BACK + 1) * t - BACK);
    default: {
      const w = t - 1;
      return w * w * ((BACK + 1) * w + BACK) + 1;
    }
  }
}

/**
 * One of the game's value tweens, as the camera triggers use them: a value
 * eased from where it stood to a target over a move time. Starting one
 * replaces whatever its slot was doing. [gdp GJGameState::tweenValue
 * :448905-448945]
 */
export interface CameraTween {
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  easing: number;
  rate: number;
  /**
   * The trigger that started it, by object index, and that trigger's control
   * id (key 534): what a Stop, Pause or Resume trigger finds it by. -1 for
   * both on the ones the layer starts itself, the static camera's and the
   * hand-back, which no trigger can reach. [+40 and +44 of the tween's entry,
   * :448935-448936; controlTweenAction :451598-451640]
   */
  uid: number;
  controlId: number;
  /** Held by a Pause trigger until a Resume: it neither steps nor ends. [+37; GJValueTween::step :417576-417577] */
  paused: boolean;
}

/**
 * One step of a tween, in floats as the game keeps them; done once `elapsed`
 * reaches `duration`. [gdp GJValueTween::step :417562-417600]
 */
export function stepCameraTween(t: CameraTween, dt: number): number {
  t.elapsed = Math.fround(t.elapsed + dt);
  let p = t.elapsed >= t.duration ? 1 : Math.fround(t.elapsed / t.duration);
  if (t.easing > 0) p = Math.fround(easedValue(p, t.easing, t.rate));
  return Math.fround(t.from + (t.to - t.from) * p);
}

/** Whether a tween has reached its move time. */
export function cameraTweenDone(t: CameraTween): boolean {
  return t.elapsed >= t.duration;
}
