// The screen effects: the one ShaderLayer every shader trigger talks to.
//
// Each shader trigger (2904-2924) hands its keys to a single layer that keeps
// one value per effect parameter and eases it toward what the latest trigger
// asked for, over that trigger's duration and easing. An effect is not a pass
// that is pushed and popped: it is on while its values say so, and a trigger
// that "turns it off" is one that eases it back to zero. The setup trigger
// (2904) picks which of the fifteen draw layers the effects reach, and only
// that band of the scene goes through the shader; everything below it and
// above it is drawn as it is.
//
// Every key a shader trigger leaves out is zero. The game writes a key into a
// level only when it is not zero and reads a missing one back as zero, so an
// Invert Color with no strength is an invert that turns itself off, not one at
// full strength. [gdp ShaderGameObject::customObjectSetup :308798-309007,
// getSaveString :319362ff]
//
// [gdp GJBaseGameLayer::triggerShaderCommand, gd-ida-decomp.cpp:422254-422603;
//  ShaderLayer::tweenValueAuto :660404-660640; GJShaderState::tweenValue
//  :660310-660345; GJValueTween::step :417562-417600;
//  GJBaseGameLayer::updateShaderLayer :424443-424961]

import { easedValue } from "./easing";
import { num, type TriggerSpec } from "./spec";

/**
 * The layer numbers keys 196 and 197 store, and the order the scene is drawn
 * in: background, middleground, the five layers behind the player, the
 * player, the four in front, the ground, the interface.
 * [SetupShaderEffectPopup::zLayerToString :662927-662989]
 */
export const SHADER_LAYER = {
  BG: 1,
  MG: 2,
  B5: 3,
  B4: 4,
  B3: 5,
  B2: 6,
  B1: 7,
  P: 8,
  T1: 9,
  T2: 10,
  T3: 11,
  T4: 12,
  G: 13,
  UI: 14,
  MAX: 15,
} as const;

/**
 * GJBaseGameLayer::minZOrderForShaderZ, by layer. The 2.206 build keeps it as
 * a table the decompile does not have (:422613-422622); these are the 2.2074
 * exe's own, read off its jump table at VA 0x140223700.
 */
const MIN_Z: readonly number[] = [0, -1600, -1600, -1500, -1200, -900, -600, -300, 39, 100, 400, 700, 1000, 1400, 1400, 1400];

/** The lowest z order of the object layer's children a draw layer takes in. */
export function minZOrder(layer: number): number {
  return layer >= 1 && layer <= 15 ? MIN_Z[layer] : 0;
}

/** The highest. [GJBaseGameLayer::maxZOrderForShaderZ :422638-422672] */
export function maxZOrder(layer: number): number {
  if (layer === 1 || layer === 2) return -1600;
  if (layer === 8) return 61;
  if (layer === 15) return 1400;
  return layer >= 3 && layer <= 14 ? minZOrder(layer + 1) - 1 : 0;
}

/**
 * Where the things the renderer draws on its own sit among the object layer's
 * children: the streak, the player's particles on either side of it, the
 * spider's dash sprite, the Ghost Trail's copies and the player. The copies
 * go in one under the player itself: the effect's +296 is the PlayerObject
 * (the icon sprite is +292), and trailSnapshot adds each copy to the object
 * layer at that node's z less one, 58 — over B1's gradients, the particles
 * under the player and the dash sprite, under the player. Both players are at
 * 59, so both trails are at 58.
 * [PlayerObject streak :160789-160811; GhostTrailEffect::trailSnapshot
 *  :59230-59233, :59276-59281 (+300's addChild at +296's getZOrder − 1);
 *  runWithTarget :59450 (+292 the icon sprite); PlayerObject::
 *  toggleGhostEffect :147158, :147182 (+296 the player), :147200 (+300 the
 *  object layer, PlayLayer +2508); addAllParticles :141835-141880; spider
 *  dash :145909-145913; GJBaseGameLayer::createPlayer :417928-417931,
 *  spawnPlayer2 :420888 (z 59)]
 */
export const OBJECT_Z = { STREAK: -3, PARTICLES_UNDER: 39, SPIDER_DASH: 40, GHOST: 58, PLAYER: 59, PARTICLES_OVER: 61 } as const;

/**
 * The nine batch layers an object's key-24 layer lands in, back to front,
 * each as a z inside the range of z orders its batches take. Any z in the
 * range gives the same answer to the band tests, so these sit in the middle.
 * [GJBaseGameLayer::parentForZLayer :435785-435830; the batches' z orders,
 *  GJBaseGameLayer::init :434848-435720]
 */
export const LAYER_Z: readonly number[] = [-1400, -1100, -800, -500, -200, 200, 500, 800, 1100];
/** How many of LAYER_Z sit behind the player: B5 to B1. */
export const LAYERS_BEHIND = 5;

/**
 * An object's layer as the game reads it: key 24 when the level set one, the
 * object's own default when it did not or set zero.
 * [GameObject::getObjectZLayer :169016-169023]
 */
export function effectiveZLayer(custom: number | null, fallback: number | undefined): number {
  return custom !== null && custom !== 0 ? custom : (fallback ?? 0);
}

/**
 * An object's z order inside its layer, by the same rule: key 25 when the
 * level set one, the object's own default when it did not or set zero.
 * [GameObject::getObjectZOrder :169248-169255; key 25 read into +976 by
 *  objectFromVector :184002-184009]
 */
export function effectiveZOrder(custom: number | null | undefined, fallback: number | undefined): number {
  return custom !== null && custom !== undefined && custom !== 0 ? custom : (fallback ?? 0);
}

/** Tween ids, which are also the slots of `ShaderState.v`. [GJShaderState::updateTweenAction :656133-656300] */
export const TWEEN = {
  CHROMATIC_X: 1,
  CHROMATIC_Y: 2,
  CG_RGB: 3,
  CG_STRENGTH: 4,
  CG_LINE_THICK: 5,
  CG_LINE_STRENGTH: 6,
  CG_HEIGHT: 7,
  CG_SPEED: 8,
  PIXELATE_X: 9,
  PIXELATE_Y: 10,
  LENS_SIZE: 11,
  LENS_FADE: 12,
  LENS_STRENGTH: 13,
  LENS_X: 14,
  LENS_Y: 15,
  RADIAL: 16,
  RADIAL_X: 17,
  RADIAL_Y: 18,
  MOTION_X: 19,
  MOTION_Y: 20,
  BULGE: 21,
  BULGE_X: 22,
  BULGE_Y: 23,
  BULGE_RADIUS: 24,
  PINCH_X: 25,
  PINCH_Y: 26,
  PINCH_CX: 27,
  PINCH_CY: 28,
  PINCH_RADIUS: 29,
  PINCH_MOD_X: 30,
  PINCH_MOD_Y: 31,
  GRAYSCALE: 32,
  SEPIA: 33,
  INVERT: 34,
  INVERT_R: 35,
  INVERT_G: 36,
  INVERT_B: 37,
  HUE: 38,
  CC_R: 39,
  CC_G: 40,
  CC_B: 41,
  CC_ADD_R: 42,
  CC_ADD_G: 43,
  CC_ADD_B: 44,
  SPLIT_ROWS: 45,
  SPLIT_COLS: 46,
  BLUR_INTENSITY: 47,
  BLUR_FADE: 48,
  GLITCH: 49,
  SW_SPEED: 50,
  SW_THICK: 51,
  SW_STRENGTH: 52,
  SW_WAVES: 53,
  SW_FADE_IN: 54,
  SW_FADE_OUT: 55,
  SW_MIN: 56,
  SW_X: 57,
  SW_Y: 58,
  SW_MAX: 59,
  SW_DIST: 60,
  SW_OFFSET: 61,
  SL_SPEED: 62,
  SL_THICK: 63,
  SL_STRENGTH: 64,
  SL_WAVES: 65,
  SL_FADE_IN: 66,
  SL_FADE_OUT: 67,
  SL_POS: 68,
  SL_DIST: 69,
  SL_OFFSET: 70,
} as const;
const SLOTS = 71;

/**
 * The ids the game hands to triggerShaderCommand. 2906, 2908 and 2918 sit in
 * the same number range and are not shader triggers: triggerObject drops them.
 * [EffectGameObject::triggerObject :314940-314970]
 */
export const SHADER_TRIGGER_IDS: ReadonlySet<number> = new Set([
  2904, 2905, 2907, 2909, 2910, 2911, 2912, 2913, 2914, 2915, 2916, 2917, 2919, 2920, 2921, 2922, 2923, 2924,
]);

/**
 * The clock the moving effects run off. The game starts it at 10000 plus a
 * random jitter of up to 100 and puts it back there on a reset; the jitter
 * only seeds the glitch noise, so a fixed start keeps two runs of a macro
 * identical. [ShaderLayer::init :661582-661584; resetAllShaders :659749]
 */
export const SHADER_CLOCK_START = 10000;

export interface ShaderTween {
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  easing: number;
  rate: number;
}

/**
 * What the triggers store outright rather than ease. Flat, so a checkpoint
 * copies it with a spread. The distortions' own settings (centres, targets,
 * the follow and invert switches) are not kept yet: nothing draws them.
 */
export interface ShaderSettings {
  /** Key 194 on an Invert Color with key 188: clamp each channel's weight at 1. [+904] */
  invertClamp: boolean;
  /** Key 188 on a Grayscale: luminance rather than the plain average. [+872] */
  grayscaleUseLum: boolean;
  /** Key 51 on a Grayscale with key 190: the channel it tints by; 0 is white. [+876] */
  grayscaleTint: number;
  /** The Lens Circle's centre target (138/200/201/51), tint channel (71) and key 514. [+684, +688, +692] */
  lensTarget: number;
  lensTint: number;
  lensRelative: boolean;
  /** Key 514 on a Chromatic: the offset scales with the camera's zoom. [+620] */
  chromaticRelative: boolean;
  /** Key 71 on the blurs, the colour an empty texel is filled with. [+416] */
  blurRefChannel: number;
  /** Key 515 on the blurs: blur only what is empty. [+420] */
  blurOnlyEmpty: boolean;
  /**
   * The shock wave's and shock line's start times, zero until one fires, and
   * how far each has run; the chromatic glitch's switch, last time and phase.
   * [triggerShockWave :660656-660717 (+424, +428); triggerShockLine
   *  :660734-660795 (+504, +512); triggerChromaticGlitch :660894-660955
   *  (+656, +624, +628)]
   */
  shockWaveStart: number;
  shockWavePhase: number;
  shockLineStart: number;
  shockLinePhase: number;
  cgOn: boolean;
  cgLast: number;
  cgPhase: number;
}

export interface ShaderState {
  /** Keys 196 and 197 as updateZLayer leaves them: 1..15. */
  layerMin: number;
  layerMax: number;
  /** Key 188 on the setup trigger: narrows the player layer to z 40..60. */
  noPlayerParticles: boolean;
  /** The clock, in seconds. */
  time: number;
  /** One float per tween id, as the game keeps them. */
  v: Float32Array;
  tweens: Map<number, ShaderTween>;
  s: ShaderSettings;
}

function defaultSettings(): ShaderSettings {
  return {
    invertClamp: false,
    grayscaleUseLum: false,
    grayscaleTint: 0,
    lensTarget: 0,
    lensTint: 0,
    lensRelative: false,
    chromaticRelative: false,
    blurRefChannel: 0,
    blurOnlyEmpty: false,
    shockWaveStart: 0,
    shockWavePhase: 0,
    shockLineStart: 0,
    shockLinePhase: 0,
    cgOn: false,
    cgLast: 0,
    cgPhase: 0,
  };
}

/** A layer as a level starts it: every effect off, the whole scene in range. */
export function createShaderState(): ShaderState {
  const st: ShaderState = {
    layerMin: 1,
    layerMax: 15,
    noPlayerParticles: false,
    time: SHADER_CLOCK_START,
    v: new Float32Array(SLOTS),
    tweens: new Map(),
    s: defaultSettings(),
  };
  resetShaderState(st);
  return st;
}

/**
 * The values the reset writes, and what to. Every other one keeps what it
 * had: the lens circle's centre (14, 15), the radial blur's (17, 18), the
 * bulge's centre and radius (22-24), the pinch's radius and modifiers
 * (29-31), the blur fade (48) and every shock wave and shock line value
 * (50-70). [GJShaderState::reset :659662-659738, read through
 *  updateTweenAction's slots :656133-656351; the pinch centre is the CCPoint
 *  at +524, set to (0, 0), unk_A9D8C4 :14511]
 */
const RESET_TO_ZERO: readonly number[] = [
  TWEEN.CHROMATIC_X, TWEEN.CHROMATIC_Y, TWEEN.CG_RGB, TWEEN.CG_STRENGTH, TWEEN.CG_LINE_THICK, TWEEN.CG_LINE_STRENGTH,
  TWEEN.CG_SPEED, TWEEN.PIXELATE_X, TWEEN.PIXELATE_Y, TWEEN.LENS_FADE, TWEEN.LENS_STRENGTH, TWEEN.RADIAL,
  TWEEN.MOTION_X, TWEEN.MOTION_Y, TWEEN.BULGE, TWEEN.PINCH_X, TWEEN.PINCH_Y, TWEEN.PINCH_CX, TWEEN.PINCH_CY,
  TWEEN.GRAYSCALE, TWEEN.SEPIA, TWEEN.INVERT, TWEEN.HUE, TWEEN.CC_ADD_R, TWEEN.CC_ADD_G, TWEEN.CC_ADD_B,
  TWEEN.SPLIT_ROWS, TWEEN.SPLIT_COLS, TWEEN.BLUR_INTENSITY, TWEEN.GLITCH,
];
const RESET_TO_ONE: readonly number[] = [
  TWEEN.CG_HEIGHT, TWEEN.LENS_SIZE, TWEEN.INVERT_R, TWEEN.INVERT_G, TWEEN.INVERT_B, TWEEN.CC_R, TWEEN.CC_G, TWEEN.CC_B,
];

/**
 * Disable All, and a restart: the values the game resets back to their
 * defaults, the clock back to its start, the range back to the whole scene.
 * The rest carry over, so a timed trigger after a reset eases from where the
 * last one left them: the values RESET_TO_ZERO and RESET_TO_ONE leave out,
 * the grayscale's tint and luminance switch, the blurs' reference channel and
 * only-empty switch, the two relative switches, and how far the shock wave,
 * the shock line and the chromatic glitch have run. The glitch's switch and
 * the shock wave's and line's start times are reset, so only a companion
 * trigger (key 513) reads the kept phases.
 * [GJShaderState::reset :659662-659738; ShaderLayer::resetAllShaders
 *  :659745-659751 → updateZLayer(0, 0, 0)]
 */
export function resetShaderState(st: ShaderState): void {
  st.tweens.clear();
  const v = st.v;
  for (const id of RESET_TO_ZERO) v[id] = 0;
  for (const id of RESET_TO_ONE) v[id] = 1;
  st.time = SHADER_CLOCK_START;
  const kept = st.s;
  st.s = defaultSettings();
  st.s.grayscaleTint = kept.grayscaleTint;
  st.s.grayscaleUseLum = kept.grayscaleUseLum;
  st.s.blurRefChannel = kept.blurRefChannel;
  st.s.blurOnlyEmpty = kept.blurOnlyEmpty;
  st.s.lensRelative = kept.lensRelative;
  st.s.chromaticRelative = kept.chromaticRelative;
  st.s.shockWavePhase = kept.shockWavePhase;
  st.s.shockLinePhase = kept.shockLinePhase;
  st.s.cgLast = kept.cgLast;
  st.s.cgPhase = kept.cgPhase;
  setLayerRange(st, 0, 0, false);
}

/** [ShaderLayer::updateZLayer :659623-659645] */
export function setLayerRange(st: ShaderState, min: number, max: number, noPlayerParticles: boolean): void {
  st.layerMin = min < 1 ? 1 : min;
  st.layerMax = max <= 0 ? 15 : max;
  st.noPlayerParticles = noPlayerParticles;
}

/**
 * Eases one value toward `to`. With no duration it is set at once and any
 * tween still running on it stops; otherwise it starts from where it is now.
 * [ShaderLayer::tweenValueAuto :660404-660640 → GJShaderState::tweenValue
 *  :660310-660345]
 */
export function tweenAuto(st: ShaderState, id: number, to: number, duration: number, easing: number, rate: number): void {
  st.tweens.delete(id);
  if (duration <= 0) {
    st.v[id] = to;
    return;
  }
  st.tweens.set(id, { from: st.v[id], to, duration, elapsed: 0, easing, rate });
}

/**
 * One frame: the clock, then every tween, then the phases that integrate a
 * speed (which read the values the tweens just wrote). The game runs this
 * once a frame with the frame's delta, after the colour fades. The shock
 * wave and line run whenever they have started; the chromatic glitch's phase
 * only moves while the glitch is drawn, and is kept under 1000.
 * [ShaderLayer::update :661546-661552; GJValueTween::step :417562-417600;
 *  GJShaderState::updateTweenActions :661499-661527; the phases in
 *  preShockWaveShader :657323-657330, preShockLineShader :657551-657562 and
 *  preChromaticGlitchShader :657941-657980, all run by performCalculations
 *  :659573-659605 from updateShaderLayer :424685]
 */
export function stepShaderState(st: ShaderState, dt: number): void {
  st.time += dt;
  for (const [id, t] of st.tweens) {
    t.elapsed += dt;
    const done = t.elapsed >= t.duration;
    let k = done ? 1 : t.elapsed / t.duration;
    if (t.easing > 0) k = easedValue(k, t.easing, t.rate);
    st.v[id] = t.from + (t.to - t.from) * k;
    if (done) st.tweens.delete(id);
  }
  const s = st.s;
  if (s.shockWaveStart > 0) {
    s.shockWavePhase += (st.time - s.shockWaveStart) * st.v[TWEEN.SW_SPEED];
    s.shockWaveStart = st.time;
  }
  if (s.shockLineStart !== 0) {
    s.shockLinePhase += (st.time - s.shockLineStart) * st.v[TWEEN.SL_SPEED];
    s.shockLineStart = st.time;
  }
  if (chromaticGlitchDrawn(st)) {
    // In floats, as the game keeps them: the whole part wrapped at 1000, the
    // fraction kept. [:657967-657980]
    const p = Math.fround(s.cgPhase + Math.fround(Math.fround(st.time - s.cgLast) * st.v[TWEEN.CG_SPEED]));
    const whole = Math.trunc(p);
    s.cgPhase = Math.fround((whole % 1000) + Math.fround(p - whole));
    s.cgLast = Math.fround(st.time);
  }
}

/**
 * Whether the chromatic glitch draws: switched on, with an offset, a strength
 * or a line strength. [preChromaticGlitchShader :657941-657942]
 */
function chromaticGlitchDrawn(st: ShaderState): boolean {
  const v = st.v;
  return st.s.cgOn && (v[TWEEN.CG_RGB] !== 0 || v[TWEEN.CG_STRENGTH] !== 0 || v[TWEEN.CG_LINE_STRENGTH] !== 0);
}

/**
 * The shader trigger's target: player 1 for key 138, player 2 for key 200,
 * -3 for key 201, else the group in key 51. [:422268-422284]
 */
export function shaderTargetOf(spec: TriggerSpec): number {
  if (on(spec, 138)) return -1;
  if (on(spec, 200)) return -2;
  if (on(spec, 201)) return -3;
  return spec.target;
}

/** The game's `atoi(value) != 0`, which is how every switch on the trigger is read. */
function on(spec: TriggerSpec, key: number): boolean {
  const raw = spec.props[key];
  if (raw === undefined) return false;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n !== 0;
}

/** An integer key, read with atoi as the layer range is. */
function atoi(spec: TriggerSpec, key: number): number {
  const raw = spec.props[key];
  if (raw === undefined) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What one shader trigger does to the layer. Key 531 is the editor's "disable
 * preview" and means nothing while a level plays.
 * [GJBaseGameLayer::triggerShaderCommand :422254-422603, and the
 *  ShaderLayer::trigger* functions it calls, :660656-661495; key 531,
 *  LevelEditorLayer::activateTriggerEffect :197243]
 */
export function applyShaderTrigger(st: ShaderState, spec: TriggerSpec): void {
  const f = (k: number): number => num(spec, k);
  const d = spec.duration;
  const e = spec.easing;
  const r = spec.easingRate;
  const tw = (id: number, to: number): void => tweenAuto(st, id, to, d, e, r);
  const s = st.s;
  switch (spec.id) {
    case 2904:
      // The range first, so a Disable All always ends back at 1..15 whatever
      // the same trigger's 196 and 197 say. [:422289-422297]
      setLayerRange(st, atoi(spec, 196), atoi(spec, 197), on(spec, 188));
      if (on(spec, 192)) resetShaderState(st);
      return;
    case 2905: {
      // A companion (key 513) carries on from where the running wave is and
      // eases into its new values; a fresh wave starts over and takes them
      // at once. [triggerShockWave :660656-660717]
      let dur = d;
      if (on(spec, 513)) {
        s.shockWavePhase += (st.time - s.shockWaveStart) * st.v[TWEEN.SW_SPEED];
      } else {
        s.shockWavePhase = 0;
        dur = 0;
      }
      s.shockWaveStart = st.time;
      const keys: readonly [number, number][] = [
        [TWEEN.SW_SPEED, 175], [TWEEN.SW_THICK, 180], [TWEEN.SW_STRENGTH, 176], [TWEEN.SW_WAVES, 179],
        [TWEEN.SW_FADE_IN, 181], [TWEEN.SW_FADE_OUT, 182], [TWEEN.SW_MIN, 183], [TWEEN.SW_X, 290],
        [TWEEN.SW_Y, 291], [TWEEN.SW_MAX, 191], [TWEEN.SW_DIST, 512], [TWEEN.SW_OFFSET, 177],
      ];
      for (const [id, key] of keys) tweenAuto(st, id, f(key), dur, e, r);
      return;
    }
    case 2907: {
      // As the wave. [triggerShockLine :660734-660795]
      let dur = d;
      if (on(spec, 513)) {
        s.shockLinePhase += (st.time - s.shockLineStart) * st.v[TWEEN.SL_SPEED];
      } else {
        s.shockLinePhase = 0;
        dur = 0;
      }
      s.shockLineStart = st.time;
      const keys: readonly [number, number][] = [
        [TWEEN.SL_SPEED, 175], [TWEEN.SL_THICK, 180], [TWEEN.SL_STRENGTH, 176], [TWEEN.SL_WAVES, 179],
        [TWEEN.SL_FADE_IN, 181], [TWEEN.SL_FADE_OUT, 182], [TWEEN.SL_POS, 290], [TWEEN.SL_DIST, 512],
        [TWEEN.SL_OFFSET, 177],
      ];
      for (const [id, key] of keys) tweenAuto(st, id, f(key), dur, e, r);
      return;
    }
    case 2909:
      // No easing on this one. [triggerGlitch :660809-660846]
      tweenAuto(st, TWEEN.GLITCH, f(176), d, 0, 0);
      return;
    case 2910:
      // [:422360-422377; triggerChromaticX/Y :660848-660892]
      if (on(spec, 188)) {
        tw(TWEEN.CHROMATIC_X, f(180));
        s.chromaticRelative = on(spec, 514);
      }
      if (on(spec, 190)) {
        tw(TWEEN.CHROMATIC_Y, f(189));
        s.chromaticRelative = on(spec, 514);
      }
      return;
    case 2911: {
      // Key 192 set to 1 switches it off. The phase and the time it was last
      // moved are floats; unlike the pre-pass, this does not wrap it.
      // [:422378-422393; triggerChromaticGlitch :660894-660955]
      if (!s.cgOn) {
        s.cgLast = Math.fround(st.time);
        s.cgPhase = Math.fround(st.time);
      }
      s.cgOn = !on(spec, 192);
      s.cgPhase = Math.fround(s.cgPhase + Math.fround(Math.fround(st.time - s.cgLast) * st.v[TWEEN.CG_SPEED]));
      s.cgLast = Math.fround(st.time);
      tw(TWEEN.CG_SPEED, f(175));
      tw(TWEEN.CG_HEIGHT, f(189) < 0.1 ? 10 : 1 / f(189));
      tw(TWEEN.CG_STRENGTH, f(176));
      tw(TWEEN.CG_LINE_THICK, f(179));
      tw(TWEEN.CG_LINE_STRENGTH, f(191));
      tw(TWEEN.CG_RGB, f(180));
      return;
    }
    case 2912:
      // Pixelate never starts below one. [:422394-422414; triggerPixelateX/Y :660957-661025]
      if (on(spec, 188)) {
        st.v[TWEEN.PIXELATE_X] = Math.max(1, st.v[TWEEN.PIXELATE_X]);
        tw(TWEEN.PIXELATE_X, f(180));
      }
      if (on(spec, 190)) {
        st.v[TWEEN.PIXELATE_Y] = Math.max(1, st.v[TWEEN.PIXELATE_Y]);
        tw(TWEEN.PIXELATE_Y, f(189));
      }
      return;
    case 2913:
      // Strength is clamped into 0..1 before it is eased. [:422416-422430; triggerLensCircle :661027-661068]
      tw(TWEEN.LENS_STRENGTH, Math.min(1, Math.max(0, f(176))));
      tw(TWEEN.LENS_FADE, f(181));
      tw(TWEEN.LENS_SIZE, f(179));
      tw(TWEEN.LENS_X, f(290));
      tw(TWEEN.LENS_Y, f(291));
      s.lensTarget = shaderTargetOf(spec);
      s.lensTint = spec.target2;
      s.lensRelative = on(spec, 514);
      return;
    case 2914:
      // [:422431-422446; triggerRadialBlur :661070-661111]
      s.blurRefChannel = spec.target2;
      tw(TWEEN.BLUR_FADE, f(181));
      tw(TWEEN.BLUR_INTENSITY, f(176));
      tw(TWEEN.RADIAL, f(179));
      tw(TWEEN.RADIAL_X, f(290));
      tw(TWEEN.RADIAL_Y, f(291));
      s.blurOnlyEmpty = on(spec, 515);
      return;
    case 2915:
      // The fade and intensity take the duration but no easing.
      // [:422447-422478; triggerMotionBlurX/Y :661113-661197]
      for (const [axis, key, id] of [
        [188, 180, TWEEN.MOTION_X],
        [190, 189, TWEEN.MOTION_Y],
      ] as const) {
        if (!on(spec, axis)) continue;
        s.blurRefChannel = spec.target2;
        tweenAuto(st, TWEEN.BLUR_FADE, f(181), d, 0, 0);
        tweenAuto(st, TWEEN.BLUR_INTENSITY, f(176), d, 0, 0);
        tw(id, f(key));
        s.blurOnlyEmpty = on(spec, 515);
      }
      return;
    case 2916:
      // [:422479-422494; triggerBulge :661199-661234]
      tw(TWEEN.BULGE, f(176));
      tw(TWEEN.BULGE_X, f(290));
      tw(TWEEN.BULGE_Y, f(291));
      tw(TWEEN.BULGE_RADIUS, f(180));
      return;
    case 2917:
      // X on key 190 and Y on key 194. [:422496-422521; triggerPinchX/Y :661236-661312]
      if (on(spec, 190)) {
        tw(TWEEN.PINCH_X, f(180));
        tw(TWEEN.PINCH_CX, f(290));
        tw(TWEEN.PINCH_RADIUS, f(512));
        tw(TWEEN.PINCH_MOD_X, f(179));
      }
      if (on(spec, 194)) {
        tw(TWEEN.PINCH_Y, f(189));
        tw(TWEEN.PINCH_CY, f(291));
        tw(TWEEN.PINCH_RADIUS, f(512));
        tw(TWEEN.PINCH_MOD_Y, f(179));
      }
      return;
    case 2919:
      // [:422524-422533; triggerGrayscale :661314-661330]
      s.grayscaleUseLum = on(spec, 188);
      if (on(spec, 190)) s.grayscaleTint = spec.target;
      tw(TWEEN.GRAYSCALE, f(176));
      return;
    case 2920:
      tw(TWEEN.SEPIA, f(176));
      return;
    case 2921:
      // The channel weights only with key 188, eased with key 190 and
      // written straight in without; a tween still running on them is not
      // stopped by the straight write. [:422542-422555; triggerInvertColor
      //  :661362-661406]
      if (on(spec, 188)) {
        s.invertClamp = on(spec, 194);
        if (on(spec, 190)) {
          tw(TWEEN.INVERT_R, f(179));
          tw(TWEEN.INVERT_G, f(180));
          tw(TWEEN.INVERT_B, f(189));
        } else {
          st.v[TWEEN.INVERT_R] = f(179);
          st.v[TWEEN.INVERT_G] = f(180);
          st.v[TWEEN.INVERT_B] = f(189);
        }
      }
      tw(TWEEN.INVERT, f(176));
      return;
    case 2922:
      // Degrees. [:422556-422562; triggerHueShift]
      tw(TWEEN.HUE, f(176));
      return;
    case 2923:
      // Multiply red, green and blue by keys 176, 191 and 175, then add 179,
      // 180 and 189. [:422564-422576; triggerColorChange]
      tw(TWEEN.CC_ADD_R, f(179));
      tw(TWEEN.CC_ADD_G, f(180));
      tw(TWEEN.CC_ADD_B, f(189));
      tw(TWEEN.CC_R, f(176));
      tw(TWEEN.CC_G, f(191));
      tw(TWEEN.CC_B, f(175));
      return;
    case 2924:
      // [:422577-422592; triggerSplitScreenCols/Rows]
      if (on(spec, 188)) tw(TWEEN.SPLIT_COLS, f(180));
      if (on(spec, 190)) tw(TWEEN.SPLIT_ROWS, f(189));
      return;
  }
}

/**
 * Whether any effect is on, which is what decides whether the band is drawn
 * through the shader at all. Purely a function of the values: the pre-passes'
 * getActionByTag checks are left over from before 2.2's tweens, which never
 * run as actions. [the +958 flag, set by each pre-pass
 *  :657279-659480]
 */
export function shaderActive(st: ShaderState): boolean {
  const v = st.v;
  const s = st.s;
  if (v[TWEEN.CHROMATIC_X] !== 0 || v[TWEEN.CHROMATIC_Y] !== 0) return true;
  if (chromaticGlitchDrawn(st)) return true;
  if (v[TWEEN.PIXELATE_X] > 1 || v[TWEEN.PIXELATE_Y] > 1) return true;
  if (v[TWEEN.LENS_STRENGTH] > 0) return true;
  if (v[TWEEN.RADIAL] !== 0) return true;
  if (v[TWEEN.MOTION_X] !== 0 || v[TWEEN.MOTION_Y] !== 0) return true;
  if (v[TWEEN.BULGE] > 0) return true;
  if (v[TWEEN.PINCH_X] !== 0 || v[TWEEN.PINCH_Y] !== 0) return true;
  if (v[TWEEN.GRAYSCALE] > 0 || v[TWEEN.SEPIA] > 0 || v[TWEEN.INVERT] > 0) return true;
  if (v[TWEEN.HUE] !== 0) return true;
  if (!colourChangeIsIdentity(st)) return true;
  if (v[TWEEN.SPLIT_ROWS] !== 0 || v[TWEEN.SPLIT_COLS] !== 0) return true;
  if (s.shockWaveStart > 0 && v[TWEEN.SW_STRENGTH] > 0) return true;
  if (s.shockLineStart !== 0 && v[TWEEN.SL_STRENGTH] > 0) return true;
  return v[TWEEN.GLITCH] > 0;
}

/** [ShaderLayer::preColorChangeShader :659117-659186] */
function colourChangeIsIdentity(st: ShaderState): boolean {
  const v = st.v;
  return (
    v[TWEEN.CC_R] === 1 &&
    v[TWEEN.CC_G] === 1 &&
    v[TWEEN.CC_B] === 1 &&
    v[TWEEN.CC_ADD_R] === 0 &&
    v[TWEEN.CC_ADD_G] === 0 &&
    v[TWEEN.CC_ADD_B] === 0
  );
}

/** -1 below the band, 0 in it, 1 above it. */
export type BandSide = -1 | 0 | 1;

export interface BandZ {
  lo: number;
  hi: number;
}

/**
 * The z orders the band takes in, with key 188's narrowing of the player
 * layer to what lies between its particles.
 * [updateShaderLayer :424843-424873, :424877-424939]
 */
export function bandZ(st: ShaderState, out: BandZ = { lo: 0, hi: 0 }): BandZ {
  let lo = minZOrder(st.layerMin);
  let hi = maxZOrder(st.layerMax);
  if (st.noPlayerParticles) {
    if (st.layerMin === SHADER_LAYER.P) lo = 40;
    if (st.layerMax === SHADER_LAYER.P) hi = 60;
  }
  out.lo = lo;
  out.hi = hi;
  return out;
}

/**
 * Which side of the band something in the object layer falls on. With the
 * background in the band, everything below it is too. `band` is bandZ(st),
 * for a caller asking about several things at once. [:424912-424935]
 */
export function objectSide(z: number, st: ShaderState, band: BandZ = bandZ(st)): BandSide {
  if (z < band.lo) return st.layerMin <= 1 ? 0 : -1;
  return z <= band.hi ? 0 : 1;
}

/** [:424782-424792] */
export function backgroundSide(st: ShaderState): BandSide {
  return st.layerMin <= 1 ? 0 : -1;
}

/** [:424793-424801] */
export function middlegroundSide(st: ShaderState): BandSide {
  return st.layerMin <= 1 || (st.layerMin === 2 && st.layerMax > 1) ? 0 : -1;
}

/** The ground and its line, and the ceiling with them. [:424802-424824] */
export function groundSide(st: ShaderState): BandSide {
  if (st.layerMin <= 1) return st.layerMax <= 12 ? 1 : 0;
  if (st.layerMax <= 12) return 1;
  return st.layerMin <= 13 ? 0 : -1;
}

/**
 * The parts of the scene the renderer draws, in the order it draws them when
 * no band splits it: the background, the middleground, the five batch layers
 * behind the player (B5 to B1), the streak, the player's particles under it,
 * the player, the particles over it, the four batch layers in front (T1 to
 * T4), and the ground.
 */
export const SCENE_PART = {
  BACKGROUND: 0,
  MIDDLEGROUND: 1,
  /** B5, with B4 to B1 after it. */
  BEHIND: 2,
  /** The streak (−3), with the rest of B1 over it: the objects' own particle systems and B1's gradients. */
  STREAK: 7,
  PARTICLES_UNDER: 8,
  PLAYER: 9,
  PARTICLES_OVER: 10,
  /** T1, with T2 to T4 after it. */
  FRONT: 11,
  GROUND: 15,
} as const;
export const SCENE_PARTS = 16;

/** The batch layer (a LAYER_Z slot) a scene part draws, or -1 for a part that is not one. */
export function layerOfPart(part: number): number {
  if (part >= SCENE_PART.BEHIND && part < SCENE_PART.BEHIND + LAYERS_BEHIND) return part - SCENE_PART.BEHIND;
  if (part >= SCENE_PART.FRONT && part < SCENE_PART.GROUND) return part - SCENE_PART.FRONT + LAYERS_BEHIND;
  return -1;
}

/** Which side of the band one scene part falls on. */
export function partSide(part: number, st: ShaderState, band: BandZ = bandZ(st)): BandSide {
  switch (part) {
    case SCENE_PART.BACKGROUND:
      return backgroundSide(st);
    case SCENE_PART.MIDDLEGROUND:
      return middlegroundSide(st);
    case SCENE_PART.STREAK:
      return objectSide(OBJECT_Z.STREAK, st, band);
    case SCENE_PART.PARTICLES_UNDER:
      return objectSide(OBJECT_Z.PARTICLES_UNDER, st, band);
    case SCENE_PART.PLAYER:
      return objectSide(OBJECT_Z.PLAYER, st, band);
    case SCENE_PART.PARTICLES_OVER:
      return objectSide(OBJECT_Z.PARTICLES_OVER, st, band);
    case SCENE_PART.GROUND:
      return groundSide(st);
    default:
      return objectSide(LAYER_Z[layerOfPart(part)], st, band);
  }
}

const scratchBand: BandZ = { lo: 0, hi: 0 };
const scratchSides = new Int8Array(SCENE_PARTS);

/**
 * The order the scene's parts are drawn in with the band at `st`, into
 * `order`, with each one's side at the same index of `sides`: everything
 * below the band, then everything in it, then everything above it, each in
 * the plain order. The game draws the band as one node, so it lies over
 * everything below it and under everything above it whatever order those
 * parts come in. Within 1..15 the sides already run in the plain order;
 * past 15 they need not. updateZLayer passes a number over 15 through and it
 * has no z range (maxZOrder gives 0), so a band from BG to 16 ends below the
 * player but still takes the ground, which is drawn last: the ground goes
 * into the band, under the player and T1 to T4.
 * [updateShaderLayer :424782-424939; updateZLayer :659623-659645]
 */
export function sceneOrder(st: ShaderState, order: Uint8Array, sides: Int8Array): void {
  const band = bandZ(st, scratchBand);
  for (let part = 0; part < SCENE_PARTS; part++) scratchSides[part] = partSide(part, st, band);
  let at = 0;
  for (let side = -1; side <= 1; side++) {
    for (let part = 0; part < SCENE_PARTS; part++) {
      if (scratchSides[part] !== side) continue;
      order[at] = part;
      sides[at] = side;
      at++;
    }
  }
}

/** The colour effects' uniforms, as the pre-passes compute them. */
export interface ColourUniforms {
  grayscale: number;
  grayscaleUseLum: boolean;
  grayscaleTint: [number, number, number];
  sepia: number;
  invert: [number, number, number, number];
  hueCos: number;
  hueSin: number;
  colorChangeC: [number, number, number];
  colorChangeB: [number, number, number];
}

export function newColourUniforms(): ColourUniforms {
  return {
    grayscale: 0,
    grayscaleUseLum: false,
    grayscaleTint: [1, 1, 1],
    sepia: 0,
    invert: [0, 0, 0, 0],
    hueCos: 1,
    hueSin: 0,
    colorChangeC: [0, 0, 0],
    colorChangeB: [0, 0, 0],
  };
}

/** The game's own degree-to-radian constant, which is a little short of π/180. */
const DEG = 0.017453;

/**
 * [pre{Grayscale,Sepia,InvertColor,HueShift,ColorChange}Shader :658879-659186;
 *  the grayscale's tint colour, updateShaderLayer :424553-424561]
 */
export function colourUniforms(
  st: ShaderState,
  colourOf: (channel: number) => { r: number; g: number; b: number },
  out: ColourUniforms = newColourUniforms(),
): ColourUniforms {
  const v = st.v;
  out.grayscale = v[TWEEN.GRAYSCALE];
  out.grayscaleUseLum = st.s.grayscaleUseLum;
  if (st.s.grayscaleTint > 0) {
    const c = colourOf(st.s.grayscaleTint);
    out.grayscaleTint[0] = c.r / 255;
    out.grayscaleTint[1] = c.g / 255;
    out.grayscaleTint[2] = c.b / 255;
  } else {
    out.grayscaleTint[0] = out.grayscaleTint[1] = out.grayscaleTint[2] = 1;
  }
  out.sepia = v[TWEEN.SEPIA];
  const inv = v[TWEEN.INVERT];
  let ir = Math.fround(inv * v[TWEEN.INVERT_R]);
  let ig = Math.fround(inv * v[TWEEN.INVERT_G]);
  let ib = Math.fround(inv * v[TWEEN.INVERT_B]);
  if (st.s.invertClamp) {
    ir = Math.min(1, ir);
    ig = Math.min(1, ig);
    ib = Math.min(1, ib);
  }
  out.invert[0] = ir;
  out.invert[1] = ig;
  out.invert[2] = ib;
  out.invert[3] = inv;
  const a = v[TWEEN.HUE] * DEG;
  out.hueCos = Math.cos(a);
  out.hueSin = Math.sin(a);
  if (colourChangeIsIdentity(st)) {
    out.colorChangeC[0] = out.colorChangeC[1] = out.colorChangeC[2] = 0;
    out.colorChangeB[0] = out.colorChangeB[1] = out.colorChangeB[2] = 0;
  } else {
    // A red multiplier of zero would read as "off" in the shader, so it is
    // held just above. [:659166-659171]
    out.colorChangeC[0] = v[TWEEN.CC_R] > 0.001 ? v[TWEEN.CC_R] : 0.001;
    out.colorChangeC[1] = v[TWEEN.CC_G];
    out.colorChangeC[2] = v[TWEEN.CC_B];
    out.colorChangeB[0] = v[TWEEN.CC_ADD_R];
    out.colorChangeB[1] = v[TWEEN.CC_ADD_G];
    out.colorChangeB[2] = v[TWEEN.CC_ADD_B];
  }
  return out;
}

/**
 * The shader's colour tail on one colour: grayscale, sepia, invert, hue,
 * colour change, in that order whatever order the triggers fired in, and
 * nothing clamped until the framebuffer takes it. This is the fragment
 * shader's arithmetic in the game's own source, kept here so the tests can
 * hold it to numbers. [the install's fragment shader, GeometryDash.exe file
 * offset 0x604740]
 */
export function applyColourTail(c: readonly [number, number, number], u: ColourUniforms): [number, number, number] {
  let [r, g, b] = c;
  if (u.grayscale > 0) {
    const gray = u.grayscaleUseLum ? 0.299 * r + 0.587 * g + 0.114 * b : (r + g + b) * 0.333;
    r = r * (1 - u.grayscale) + gray * u.grayscale * u.grayscaleTint[0];
    g = g * (1 - u.grayscale) + gray * u.grayscale * u.grayscaleTint[1];
    b = b * (1 - u.grayscale) + gray * u.grayscale * u.grayscaleTint[2];
  }
  if (u.sepia > 0) {
    const sr = 0.393 * r + 0.769 * g + 0.189 * b;
    const sg = 0.349 * r + 0.686 * g + 0.168 * b;
    const sb = 0.272 * r + 0.534 * g + 0.131 * b;
    r = r * (1 - u.sepia) + sr * u.sepia;
    g = g * (1 - u.sepia) + sg * u.sepia;
    b = b * (1 - u.sepia) + sb * u.sepia;
  }
  if (u.invert[3] > 0) {
    r = r * (1 - u.invert[0]) + (1 - r) * u.invert[0];
    g = g * (1 - u.invert[1]) + (1 - g) * u.invert[1];
    b = b * (1 - u.invert[2]) + (1 - b) * u.invert[2];
  }
  if (u.hueCos !== 0) {
    // Rodrigues' rotation about the grey axis k = (1,1,1)/√3.
    const k = 0.57735;
    const kk = k * k * (r + g + b) * (1 - u.hueCos);
    const s = u.hueSin;
    [r, g, b] = [
      r * u.hueCos + k * (b - g) * s + kk,
      g * u.hueCos + k * (r - b) * s + kk,
      b * u.hueCos + k * (g - r) * s + kk,
    ];
  }
  if (u.colorChangeC[0] > 0) {
    r = r * u.colorChangeC[0] + u.colorChangeB[0];
    g = g * u.colorChangeC[1] + u.colorChangeB[1];
    b = b * u.colorChangeC[2] + u.colorChangeB[2];
  }
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  return [clamp(r), clamp(g), clamp(b)];
}

/**
 * What a restart from the start hands the next attempt: the last attempt's
 * layer, copied and then reset, so the values the reset leaves alone carry
 * over. A checkpoint or a start position then loads its own copy over it
 * whole. [PlayLayer::resetLevel → resetLevelVariables :462991-462996 →
 *  resetAllShaders; loadFromCheckpoint :105529-105531]
 */
export function carriedShaderState(previous: ShaderState): ShaderState {
  const st = cloneShaderState(previous);
  resetShaderState(st);
  return st;
}

/** A copy nothing done to the live layer can reach: what a checkpoint keeps. [createCheckpoint :105118] */
export function cloneShaderState(st: ShaderState): ShaderState {
  const tweens = new Map<number, ShaderTween>();
  for (const [id, t] of st.tweens) tweens.set(id, { ...t });
  return {
    layerMin: st.layerMin,
    layerMax: st.layerMax,
    noPlayerParticles: st.noPlayerParticles,
    time: st.time,
    v: st.v.slice(),
    tweens,
    s: { ...st.s },
  };
}
