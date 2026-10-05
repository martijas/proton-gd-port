// Particles: the cocos2d Particle-Designer emitter, and the definitions a level
// carries inline.
//
// A Custom Particles object (id 2065) does not point at one of the game's 51
// effect files — it keeps its whole definition in the level string, as 72
// numbers separated by "a" under property key 145. The order of those 72 is not
// guessable and is not the plist's order either: sizes, spins and colours are
// interleaved value-then-variance, and there is no texture name in it at all,
// only an index that names `particle_NN_001.png`.
// [gdp GameToolbox::particleStringToStruct and particleFromStruct, bridged to
//  names through CreateParticlePopup's own editor labels — see
//  data/ref/gd-particles.md for the index-by-index table]
//
// The emitter is cocos2d's with Geometry Dash's additions: two modes that
// share a lifetime, a size ramp, a spin ramp and a colour ramp, and on top of
// those fades at both ends, friction on the speed, the size change and the
// spin, sprites that face their motion, colour ramps shared by every particle,
// and emitters that restart on their own. Gravity mode integrates a velocity;
// radius mode sweeps an angle. Nothing here touches the simulation — particles
// are drawn and thrown away, never collided with — so the randomness is the
// renderer's own rather than the game's seeded one.
// [cocos2d::CCParticleSystem::initParticle, gd-ida-decomp.cpp:844618-845110;
//  ::update :845383-845834; CCParticleSystemQuad::updateQuadWithParticle
//  :848005-848110; ParticleGameObject :301779-301848, :306001-306381]

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import type { AtlasSet } from "../assets/atlas";
import type { HsvShift, Level, LevelObject } from "../level/types";
import { OBJECT_KEY, objectFlag } from "../level/decode";
import { frameQuad } from "./frameQuad";
import type { ViewBox } from "./drawList";
import { CHANNEL, applyHsv, channelOpacityMod, colorForPulse, pulseAppliesTo, type ColorSource, type Rgb } from "./colors";
import { effectiveZLayer, effectiveZOrder, LAYER_Z } from "../triggers/shaderState";
import { containerZ, slotOfZ } from "./batchNodes";
import type { BuiltInParticle, ObjectRecord } from "../assets/objectTypes";

/** The object that carries an inline definition. */
export const CUSTOM_PARTICLE_ID = 2065;
/** The most runs an update can make: one per z a system draws at. */
const MAX_RUNS = 256;
/**
 * A complete definition is 72 tokens, but 151 of the thousand the official
 * levels carry stop at 63 — the game refuses 62 or fewer and defaults the rest
 * to zero, so a short definition is normal rather than broken.
 */
const MIN_FIELDS = 63;
/** Particles alive at once across the whole level, so a busy screen stays bounded. */
const MAX_LIVE = 3000;
/** How far outside the view an emitter still runs, in units. */
const EMITTER_MARGIN = 240;
/** A particle's lifetime never drops below this. [initParticle :844776-844787] */
const MIN_LIFE = 0.0001;
/** How fast a dynamic rotation closes on the direction of travel: this share of the gap per second. */
const DYNAMIC_ROTATION_RATE = 10;

export interface ParticleDef {
  maxParticles: number;
  duration: number;
  life: number;
  lifeVar: number;
  emissionRate: number;
  angle: number;
  angleVar: number;
  speed: number;
  speedVar: number;
  posVarX: number;
  posVarY: number;
  gravityX: number;
  gravityY: number;
  radialAccel: number;
  radialAccelVar: number;
  tangentialAccel: number;
  tangentialAccelVar: number;
  startSize: number;
  startSizeVar: number;
  startSpin: number;
  startSpinVar: number;
  startColor: [number, number, number, number];
  startColorVar: [number, number, number, number];
  endSize: number;
  endSizeVar: number;
  endSpin: number;
  endSpinVar: number;
  endColor: [number, number, number, number];
  endColorVar: [number, number, number, number];
  /** Seconds over which a new particle fades in, and a dying one out. */
  fadeIn: number;
  fadeInVar: number;
  fadeOut: number;
  fadeOutVar: number;
  startRadius: number;
  startRadiusVar: number;
  endRadius: number;
  endRadiusVar: number;
  rotatePerSecond: number;
  rotatePerSecondVar: number;
  /** 0 gravity, 1 radius. */
  emitterMode: number;
  /**
   * 0 free, 1 relative: a particle stays where it was let go when the
   * emitter moves on. 2 grouped: every particle moves, turns and scales with
   * the emitter. The official levels use 1 and 2.
   */
  positionType: number;
  additive: boolean;
  /**
   * Three switches the editor labels "= End" and that are nothing of the kind:
   * each one flips its token between an absolute end value and a delta added to
   * the start. Reading them as the label says, or as a -1 sentinel, draws the
   * wrong size on 294 of the thousand definitions the official levels carry.
   * [gdp initParticle, gd-ida-decomp.cpp:844958-844974 for size and
   *  :845038-845046 for radius; verified against all 1,000 placements]
   */
  spinRelative: boolean;
  textureIndex: number;
  sizeRelative: boolean;
  radiusRelative: boolean;
  /** Each particle starts turned to face the way it sets off. */
  rotationIsDir: boolean;
  /** Each particle keeps turning to face the way it is going; its own spin stops. */
  dynamicRotation: boolean;
  /**
   * Every particle's colour runs the same ramp, the object's main colour to
   * its detail colour, rather than its own (key 147 on the object sets them).
   */
  uniformColor: boolean;
  /** Friction: each second a particle loses this share of its speed … */
  frictionP: number;
  frictionPVar: number;
  /** … of its size change … */
  frictionS: number;
  frictionSVar: number;
  /** … and of its spin. */
  frictionR: number;
  frictionRVar: number;
  /** Seconds between the end of one burst and the start of the next, for an emitter that runs out. */
  respawn: number;
  respawnVar: number;
  /** A dying particle keeps the others in order rather than trading places with the last. */
  orderSensitive: boolean;
  /** The start or end colour's three channels move by one random amount, the red one's. */
  startRGBVarSync: boolean;
  endRGBVarSync: boolean;
}

/**
 * Reads property key 145. Returns null for anything the game itself would
 * refuse, so a malformed definition draws nothing rather than drawing noise.
 * [GameToolbox::particleStringToStruct :44861-45137; particleFromStruct
 *  :43926-44069, tokens 41-44 and 56-71 at :44029-44064]
 */
export function parseParticleString(raw: string | undefined): ParticleDef | null {
  if (!raw) return null;
  const parts = raw.split("a");
  if (parts.length < MIN_FIELDS) return null;
  const n = (i: number): number => {
    if (i >= parts.length) return 0;
    const v = Number(parts[i]);
    return Number.isFinite(v) ? v : 0;
  };
  const b = (i: number): boolean => n(i) !== 0;
  return {
    maxParticles: Math.max(0, Math.trunc(n(0))),
    duration: n(1),
    life: n(2),
    lifeVar: n(3),
    emissionRate: n(4),
    angle: n(5),
    angleVar: n(6),
    speed: n(7),
    speedVar: n(8),
    posVarX: n(9),
    posVarY: n(10),
    gravityX: n(11),
    gravityY: n(12),
    radialAccel: n(13),
    radialAccelVar: n(14),
    tangentialAccel: n(15),
    tangentialAccelVar: n(16),
    startSize: n(17),
    startSizeVar: n(18),
    startSpin: n(19),
    startSpinVar: n(20),
    startColor: [n(21), n(23), n(25), n(27)],
    startColorVar: [n(22), n(24), n(26), n(28)],
    endSize: n(29),
    endSizeVar: n(30),
    endSpin: n(31),
    endSpinVar: n(32),
    endColor: [n(33), n(35), n(37), n(39)],
    endColorVar: [n(34), n(36), n(38), n(40)],
    fadeIn: n(41),
    fadeInVar: n(42),
    fadeOut: n(43),
    fadeOutVar: n(44),
    startRadius: n(45),
    startRadiusVar: n(46),
    endRadius: n(47),
    endRadiusVar: n(48),
    rotatePerSecond: n(49),
    rotatePerSecondVar: n(50),
    emitterMode: Math.trunc(n(51)),
    positionType: Math.trunc(n(52)),
    additive: b(53),
    spinRelative: b(54),
    rotationIsDir: b(55),
    dynamicRotation: b(56),
    textureIndex: Math.trunc(n(57)),
    uniformColor: b(58),
    frictionP: n(59),
    frictionPVar: n(60),
    respawn: n(61),
    respawnVar: n(62),
    orderSensitive: b(63),
    sizeRelative: b(64),
    radiusRelative: b(65),
    startRGBVarSync: b(66),
    endRGBVarSync: b(67),
    frictionS: n(68),
    frictionSVar: n(69),
    frictionR: n(70),
    frictionRVar: n(71),
  };
}

/**
 * The frame a definition draws with. The sheet holds 213 of them and the
 * official levels use 27, up to index 209 — so the number is padded to two
 * digits but never truncated to two.
 */
export const MAX_PARTICLE_TEXTURE = 212;

export function particleFrameName(def: ParticleDef): string {
  const index = Math.max(0, Math.min(MAX_PARTICLE_TEXTURE, Math.trunc(def.textureIndex)));
  return `particle_${String(index).padStart(2, "0")}_001.png`;
}

// --- one live particle -------------------------------------------------------

/** Floats per particle in the flat pool. */
const P_STRIDE = 24;
const P_X = 0;
const P_Y = 1;
const P_VX = 2;
const P_VY = 3;
const P_START_X = 4;
const P_START_Y = 5;
/** Seconds left. */
const P_LIFE = 6;
const P_SIZE = 7;
const P_D_SIZE = 8;
const P_ROT = 9;
const P_D_ROT = 10;
const P_RADIAL = 11;
const P_TANGENT = 12;
const P_ANGLE = 13;
const P_RADIUS = 14;
const P_D_RADIUS = 15;
/** Seconds lived. */
const P_AGE = 16;
/** 1 / the lifetime it was born with. */
const P_INV_LIFE = 17;
const P_FADE_IN = 18;
const P_FADE_OUT = 19;
/** A dynamic rotation's offset from the direction of travel, 0 for none. */
const P_DYNAMIC = 20;
const P_FRICTION_P = 21;
const P_FRICTION_S = 22;
const P_FRICTION_R = 23;

/** Colour is kept separately because it is eight floats rather than one. */
const C_STRIDE = 8;

/** Settings the object carries beside its definition. */
export interface EmitterOptions {
  /**
   * Key 123: an Animate trigger starts the emitter again, and one that runs
   * out waits for it instead of starting again on its own.
   */
  animateOnTrigger?: boolean;
}

/** An emitter's object's colours, and which of keys 146 and 147 asked for them. */
export interface ObjectColours {
  main: Rgb;
  detail: Rgb;
  useForRamp: boolean;
  useForUniform: boolean;
  /** Whether either of the object's halves blends now (+960). */
  blending: boolean;
}

/**
 * One emitter placed in a level.
 *
 * The pool is flat rather than an array of objects: an emitter can carry a few
 * hundred particles and a busy screen a few thousand, and every one of them is
 * touched every frame.
 */
export class ParticleEmitter {
  private readonly pool: Float32Array;
  private readonly colours: Float32Array;
  private live = 0;
  private emitCounter = 0;
  private elapsed = 0;
  /** Whether it is emitting at all; a stopped emitter lets what is out finish. */
  private active = true;
  private seed: number;
  /** The start and end colours new particles are drawn around, 0..1; the object can replace the rgb. */
  private readonly startColor: [number, number, number, number];
  private readonly endColor: [number, number, number, number];
  /** The shared ramp of a uniform-colour emitter, rgb 0..1, from then to. */
  private readonly uniform = new Float32Array(6);
  /**
   * The start and end colours outright, alpha and all: what a built-in
   * system's object gives it (GameObject::updateParticleColor :163689-163725
   * and claimParticle's special cases), where a Custom Particles object's
   * keep their alphas (recolour).
   */
  setColours(start: readonly number[], end: readonly number[]): void {
    for (let k = 0; k < 4; k++) {
      this.startColor[k] = start[k];
      this.endColor[k] = end[k];
    }
  }

  /** Restarts itself: an emitter that runs out (duration 0 or more). */
  private synced = false;
  /** Level time of the next restart, or -1 before one is set. */
  private nextRestart = -1;
  private firstRestart = true;
  private restartPending = false;
  /**
   * A grouped emitter's turn and scale (see follow): the 2×2 its particles
   * are drawn through about the emitter, column by column.
   */
  private readonly node = new Float64Array([1, 0, 0, 1]);
  /** The emission angle in degrees: the definition's, turned with the object unless grouped. */
  private emitAngle: number;
  /** loadScaledDefaults's factor on the sizes, the spread and the speed of a free or relative emitter. */
  private scale = 1;
  /**
   * The object's blending as the emitter last heard it (+960), and whether it
   * has heard at all: until the object's blending first changes, the
   * definition's own blend (token 53) stands. See objectBlend.
   */
  private blendHeard = false;
  private blendNow = false;
  /**
   * The whole system's opacity, 0..1 (+726, which only a Custom Particles
   * object sets): every particle's colour and alpha are drawn times it,
   * the ones already out included. See setSystemOpacity.
   */
  private opacity = 1;

  constructor(
    readonly def: ParticleDef,
    /** Where the emitter sits: follow moves a level's with its object, and the player's is set outright. */
    public x: number,
    public y: number,
    /** Seeds this emitter's own noise, so a restart looks the same. */
    index: number,
    readonly options: EmitterOptions = {},
  ) {
    const cap = Math.max(1, Math.min(def.maxParticles, 600));
    this.pool = new Float32Array(cap * P_STRIDE);
    this.colours = new Float32Array(cap * C_STRIDE);
    this.seed = (index * 2654435761) >>> 0 || 1;
    this.startColor = [...def.startColor];
    this.endColor = [...def.endColor];
    this.emitAngle = def.angle;
  }

  /** Position type 2: the particles move, turn and scale with the emitter. */
  get grouped(): boolean {
    return this.def.positionType === 2;
  }

  /**
   * Where its object is now, and how it is turned (degrees clockwise) and
   * scaled, the flips as negative scales. The emitter always sits at the
   * object. A grouped one is turned and scaled as a node, particles out
   * included. A free or relative one is never turned: its emission angle is
   * the definition's less the object's turn, or, for a flipped object, the
   * definition's direction carried through the object's turn and scale.
   * [GameObject::setPosition :164602-164627; setRotation :164465-164492 and
   *  setScaleX, setScaleY and setScale :164354-164455 (the node, when grouped);
   *  ParticleGameObject::applyParticleSettings :306209-306232 (at a claim),
   *  setRotation :306402-306415 → updateParticleAngle :306105-306146]
   */
  follow(x: number, y: number, rotation: number, scaleX: number, scaleY: number, flipped: boolean): void {
    this.x = x;
    this.y = y;
    const t = (rotation * Math.PI) / 180;
    // cocos turns clockwise; this world has y up.
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    if (this.grouped) {
      this.node[0] = cos * scaleX;
      this.node[1] = -sin * scaleX;
      this.node[2] = sin * scaleY;
      this.node[3] = cos * scaleY;
      return;
    }
    if (!flipped) {
      this.emitAngle = this.def.angle - rotation;
      return;
    }
    // The decompile's 0.017453 and 57.296 are the floats of π/180 and 180/π:
    // GeometryDash.exe holds those two and neither printed value.
    const a = Math.fround(this.def.angle * Math.fround(Math.PI / 180));
    const dx = Math.cos(a) * scaleX;
    const dy = Math.sin(a) * scaleY;
    this.emitAngle = Math.atan2(-sin * dx + cos * dy, cos * dx + sin * dy) * Math.fround(180 / Math.PI);
  }

  /**
   * A free or relative emitter's object scaled while it is on screen: its
   * sizes, spread and gravity-mode speed become the definition's times the
   * new scale (the last of x and y set). [ParticleGameObject::setScaleX/Y
   *  :306573-306606 → updateParticleScale :306486-306502 →
   *  CCParticleSystem::loadScaledDefaults :846625-846642]
   */
  rescale(scale: number): void {
    this.scale = Math.abs(scale);
  }

  get capacity(): number {
    return this.pool.length / P_STRIDE;
  }

  get count(): number {
    return this.live;
  }

  /** Whether it will add particles on its next step. */
  get running(): boolean {
    return this.active;
  }

  /** xorshift; particles never reach the simulation so any stream will do. */
  private random(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0;
    return (this.seed % 100000) / 100000;
  }

  /** cocos2d's CCRANDOM_MINUS1_1. */
  private signed(): number {
    return this.random() * 2 - 1;
  }

  /** Back to how it was built: running, empty, and not yet on screen. */
  reset(): void {
    this.live = 0;
    this.emitCounter = 0;
    this.elapsed = 0;
    this.active = true;
    this.synced = false;
    this.nextRestart = -1;
    this.firstRestart = true;
    this.restartPending = false;
  }

  /**
   * What the game does when the object comes on screen and takes a particle
   * system. An emitter that runs out starts stopped and waits for its first
   * restart; one that runs for ever just runs. The object's colours, when it
   * asked for them (key 146 or 147), are read now, and again by recolour
   * whenever they change.
   * [ParticleGameObject::claimParticle :306373-306379 (stopSystem for a
   *  duration of 0 or more, +1552, +1548 = -1); applyParticleSettings
   *  :306240-306299]
   */
  claim(colours: ObjectColours | null = null): void {
    this.reset();
    this.scale = 1;
    if (colours) this.recolour(colours);
    if (this.def.duration >= 0) {
      this.synced = true;
      this.stop();
    }
  }

  /**
   * The object's colours, as the game hands them over each time it colours
   * the object. Nothing restarts. Key 146 makes them the start and end rgb,
   * the alphas and every variance staying as defined: particles already out
   * keep theirs and new ones take the new colours. Key 147 makes them the
   * shared ramp a uniform-colour definition runs, which every particle reads
   * each step, so the ones already out change too.
   * [ParticleGameObject::setObjectColor :298118-298160 and setChildColor
   *  :297876-297916 (146 → setStartColor / setEndColor keeping the alpha,
   *  147 → +612 / +628); update :845707-845725]
   */
  recolour(colours: ObjectColours): void {
    if (colours.useForRamp) {
      this.startColor[0] = colours.main.r / 255;
      this.startColor[1] = colours.main.g / 255;
      this.startColor[2] = colours.main.b / 255;
      this.endColor[0] = colours.detail.r / 255;
      this.endColor[1] = colours.detail.g / 255;
      this.endColor[2] = colours.detail.b / 255;
    } else if (colours.useForUniform) {
      this.uniform[0] = colours.main.r / 255;
      this.uniform[1] = colours.main.g / 255;
      this.uniform[2] = colours.main.b / 255;
      this.uniform[3] = colours.detail.r / 255;
      this.uniform[4] = colours.detail.g / 255;
      this.uniform[5] = colours.detail.b / 255;
    }
  }

  /**
   * An emitter that takes its object's colours (key 146 or 147) also takes its
   * blending, but only when it changes: the object's blend flag starts off,
   * and each time it is set to something new the system is made additive or
   * normal to match. So the emitter adds while its object's colour blends,
   * whatever its definition says, and goes back to normal if a colour trigger
   * turns the blending off again; an object that never blends leaves the
   * definition's choice alone.
   * [ParticleGameObject::blendModeChanged :297285-297296, called by
   *  GameObject::addMainSpriteToParent :169317-169322 on a change of +960;
   *  +960 is 0 from the constructor :165636]
   */
  objectBlend(blending: boolean): void {
    if (blending === this.blendNow) return;
    this.blendNow = blending;
    this.blendHeard = true;
  }

  /** Whether its particles add rather than cover, now. */
  get additive(): boolean {
    return this.blendHeard ? this.blendNow : this.def.additive;
  }

  /** stopSystem: no more particles; the ones out finish. [:845126-845132] */
  private stop(): void {
    this.active = false;
    this.elapsed = this.def.duration;
    this.emitCounter = 0;
  }

  /**
   * Stops it emitting if it is (stopSystem), or lets it emit again if it is
   * not (resumeSystem, which leaves the clock where stopSystem put it). What
   * an object's own system is told each frame its object is given an
   * opacity: see ParticleField. [GameObject::updateParticleOpacity
   * :165124-165150; CCParticleSystem::stopSystem :845126-845132,
   * resumeSystem :845148-845152]
   */
  setEmitting(on: boolean): void {
    if (on) this.active = true;
    else if (this.active) this.stop();
  }

  /**
   * A Custom Particles object's opacity, as the game hands it to its system
   * each frame: every particle is drawn times it, the ones already out too.
   * [ParticleGameObject::updateMainParticleOpacity :297309-297327 (+726);
   *  CCParticleSystemQuad::updateQuadWithParticle :848041-848063]
   */
  setSystemOpacity(opacity: number): void {
    this.opacity = clamp01(opacity);
  }

  /**
   * The start alpha new particles are drawn around, which a Custom Particles
   * object on its own colours (key 146) takes from its opacity each frame:
   * the definition's start alpha then counts for nothing. [ParticleGameObject::
   * updateMainParticleOpacity :297309-297327 (+669 → +496, the start colour's
   * alpha); its end alpha (+528) is updateSecondaryParticleOpacity's, which
   * GameObject::setOpacity never calls for one (+548, :167660)]
   */
  setStartAlpha(alpha: number): void {
    this.startColor[3] = clamp01(alpha);
  }

  /** resetSystem: running again from the top, with everything out gone. [:845326-845367] */
  restart(): void {
    this.active = true;
    this.elapsed = 0;
    this.live = 0;
  }

  /** An Animate trigger reached the object; an emitter with key 123 starts again at its next sync. */
  animate(): void {
    if (this.options.animateOnTrigger) this.restartPending = true;
  }

  /**
   * The object's synced animation, once a frame while it is on screen. An
   * emitter that runs out and does not wait for an Animate trigger starts
   * again on its own: first `respawn` seconds after it came on screen, then
   * each time a whole burst and its particles' lives have gone by, plus
   * `respawn` again. `respawn` varies by its own variance and never goes
   * below 0. `levelTime` is the level's clock in seconds.
   *
   * One that waits for an Animate trigger starts again when one has reached
   * it, whether it runs out or runs for ever: the trigger calls this itself,
   * and this asks only for key 123 and the pending start, not whether the
   * emitter runs out.
   * [ParticleGameObject::updateSyncedAnimation :301799-301846, called by
   *  PlayLayer::updateVisibility :95982-95986 with the layer's time (+792)
   *  for an emitter that runs out, and by EnhancedGameObject::
   *  triggerAnimation :620435-620442 for any]
   */
  sync(levelTime: number): void {
    if (this.options.animateOnTrigger) {
      if (this.restartPending) {
        this.restart();
        this.restartPending = false;
      }
      return;
    }
    if (!this.synced) return;
    const def = this.def;
    if (this.nextRestart < 0) {
      const wait = Math.max(0, def.respawn + def.respawnVar * this.signed());
      this.nextRestart = this.firstRestart ? levelTime + wait : levelTime + def.life + def.lifeVar + def.duration + wait;
      this.firstRestart = false;
    }
    if (this.nextRestart < levelTime) {
      this.restart();
      this.nextRestart = -1;
    }
  }

  /**
   * Advances the emitter by `dt`. `emitting` false stops it adding particles
   * while the ones already out carry on and expire — which is what a cube
   * leaving the ground has to do, because freezing them instead leaves a
   * handful of motionless specks in the air for good.
   *
   * An emission rate of -1 is the editor's "max": every step tops the pool
   * up to its capacity, so a duration of 0 is one full burst. 111 of the
   * thousand official definitions are exactly that. [update :845480-845502]
   */
  step(dt: number, budget: number, emitting = true): number {
    // A frozen frame (a pause) moves nothing and emits nothing: the game does
    // not update a system it is not stepping, and an editor "max" rate would
    // otherwise top the pool up at no time at all.
    if (dt <= 0) return budget;
    const def = this.def;
    if (this.active && def.emissionRate !== 0) {
      if (emitting && this.live < this.capacity) {
        const interval = 1 / def.emissionRate;
        this.emitCounter += dt;
        while (this.live < this.capacity && this.emitCounter > interval && budget > 0) {
          this.add();
          this.emitCounter -= interval;
          budget--;
        }
      }
      this.elapsed += dt;
      if (def.duration !== -1 && def.duration < this.elapsed) this.stop();
    }
    this.advance(dt);
    return budget;
  }

  private add(): void {
    const def = this.def;
    const i = this.live++;
    const p = i * P_STRIDE;
    const c = i * C_STRIDE;
    const pool = this.pool;
    const life = Math.max(MIN_LIFE, def.life + def.lifeVar * this.signed());
    pool[p + P_LIFE] = life;
    pool[p + P_AGE] = 0;
    pool[p + P_INV_LIFE] = 1 / life;
    const scale = this.scale;
    pool[p + P_X] = this.x + def.posVarX * scale * this.signed();
    pool[p + P_Y] = this.y + def.posVarY * scale * this.signed();
    pool[p + P_START_X] = this.x;
    pool[p + P_START_Y] = this.y;

    // Colours. With a sync switch the three channels move by the red
    // variance's one random amount; the alpha always has its own.
    // [initParticle :844795-844883]
    const colours = this.colours;
    const ramp = (base: number[], vary: readonly number[], sync: boolean, out: number): void => {
      const common = vary[0] * this.signed();
      for (let k = 0; k < 3; k++) {
        const offset = sync ? common : k === 0 ? common : vary[k] * this.signed();
        colours[c + out + k] = clamp01(base[k] + offset);
      }
      colours[c + out + 3] = clamp01(base[3] + vary[3] * this.signed());
    };
    ramp(this.startColor, def.startColorVar, def.startRGBVarSync, 0);
    ramp(this.endColor, def.endColorVar, def.endRGBVarSync, 4);
    for (let k = 0; k < 4; k++) colours[c + 4 + k] = (colours[c + 4 + k] - colours[c + k]) / life;

    // The fades, each held inside what is left of the life. [:844885-844933]
    const fadeIn = clampFade(def.fadeIn + def.fadeInVar * this.signed(), life);
    pool[p + P_FADE_IN] = fadeIn;
    pool[p + P_FADE_OUT] = clampFade(def.fadeOut + def.fadeOutVar * this.signed(), life - fadeIn);

    const startSize = Math.max(0, (def.startSize + def.startSizeVar * this.signed()) * scale);
    pool[p + P_FRICTION_P] = def.frictionP + def.frictionPVar * this.signed();
    pool[p + P_FRICTION_S] = def.frictionS + def.frictionSVar * this.signed();
    pool[p + P_FRICTION_R] = def.frictionR + def.frictionRVar * this.signed();
    const endToken = def.endSize * scale + def.endSizeVar * this.signed();
    const endSize = Math.max(0, def.sizeRelative ? startSize + endToken : endToken);
    pool[p + P_SIZE] = startSize;
    pool[p + P_D_SIZE] = (endSize - startSize) / life;

    // Spins are whole degrees; the start is kept inside a turn, the end is
    // taken against the start before that. [:844975-845013]
    const spin = Math.trunc(def.startSpin + def.startSpinVar * this.signed());
    let rot = Math.abs(spin) > 360 ? spin % 360 : spin;
    if (rot < 0) rot += 360;
    if (def.dynamicRotation) {
      pool[p + P_D_ROT] = 0;
      pool[p + P_DYNAMIC] = rot <= 270 ? rot + 90 : rot - 270;
    } else {
      pool[p + P_DYNAMIC] = 0;
      const endSpin = Math.trunc(def.endSpin + def.endSpinVar * this.signed());
      pool[p + P_D_ROT] = (def.spinRelative ? endSpin : endSpin - spin) / life;
    }

    // The angle is stored the way cocos2d means it: degrees counter-clockwise
    // from the right, which in this port's clockwise world is a negation. It
    // is whole degrees too.
    const angleDeg = Math.trunc(this.emitAngle + def.angleVar * this.signed());
    const angle = (angleDeg * Math.PI) / 180;
    const facing = def.rotationIsDir || def.dynamicRotation;
    if (def.emitterMode === 1) {
      const startRadius = def.startRadius + def.startRadiusVar * this.signed();
      const endToken = def.endRadius + def.endRadiusVar * this.signed();
      const endRadius = def.radiusRelative ? startRadius + endToken : endToken;
      pool[p + P_RADIUS] = startRadius;
      pool[p + P_D_RADIUS] = (endRadius - startRadius) / life;
      pool[p + P_ANGLE] = angle;
      const perSecond = ((def.rotatePerSecond + def.rotatePerSecondVar * this.signed()) * Math.PI) / 180;
      pool[p + P_VX] = perSecond;
      // [:845064-845076]
      if (facing) {
        rot += 90 - (Math.atan2(Math.sin(angle), Math.cos(angle)) * 180) / Math.PI;
        if (def.dynamicRotation && perSecond === 0) pool[p + P_DYNAMIC] = 0;
      }
    } else {
      const speed = (def.speed + def.speedVar * this.signed()) * scale;
      pool[p + P_VX] = Math.cos(angle) * speed;
      pool[p + P_VY] = Math.sin(angle) * speed;
      pool[p + P_RADIAL] = def.radialAccel + def.radialAccelVar * this.signed();
      pool[p + P_TANGENT] = def.tangentialAccel + def.tangentialAccelVar * this.signed();
      // [:845100-845107]
      if (facing) rot += 90 - (Math.atan2(pool[p + P_VY], pool[p + P_VX]) * 180) / Math.PI;
    }
    pool[p + P_ROT] = rot;
  }

  private advance(dt: number): void {
    const def = this.def;
    const pool = this.pool;
    const colours = this.colours;
    const radius = def.emitterMode === 1;
    // Order only shows under normal blending, and only there does the game
    // keep it. [update :845515-845517, :845792-845818]
    const keepOrder = def.orderSensitive && !def.additive;
    for (let i = 0; i < this.live; ) {
      const p = i * P_STRIDE;
      pool[p + P_LIFE] -= dt;
      if (pool[p + P_LIFE] <= 0) {
        this.remove(i, keepOrder);
        continue;
      }
      pool[p + P_ROT] += pool[p + P_D_ROT] * dt;
      const dynamic = pool[p + P_DYNAMIC];
      if (radius) {
        pool[p + P_RADIUS] += pool[p + P_D_RADIUS] * dt;
        pool[p + P_ANGLE] += pool[p + P_VX] * dt;
        const x = pool[p + P_START_X] - Math.cos(pool[p + P_ANGLE]) * pool[p + P_RADIUS];
        const y = pool[p + P_START_Y] - Math.sin(pool[p + P_ANGLE]) * pool[p + P_RADIUS];
        if (dynamic !== 0) {
          // Turned toward the way it moved this frame, all at once in its
          // first tenth of a second. [:845646-845705]
          const heading = (Math.atan2(y - pool[p + P_Y], x - pool[p + P_X]) * 180) / Math.PI;
          const gap = wrap180(dynamic - heading - pool[p + P_ROT]);
          pool[p + P_ROT] += pool[p + P_AGE] < 0.1 ? gap : gap * dt * DYNAMIC_ROTATION_RATE;
        }
        pool[p + P_X] = x;
        pool[p + P_Y] = y;
      } else {
        // Radial acceleration points away from where the particle started;
        // tangential is the same vector turned a quarter turn.
        let rx = pool[p + P_X] - pool[p + P_START_X];
        let ry = pool[p + P_Y] - pool[p + P_START_Y];
        const len = Math.hypot(rx, ry);
        if (len > 0) {
          rx /= len;
          ry /= len;
        }
        const radial = pool[p + P_RADIAL];
        const tangent = pool[p + P_TANGENT];
        pool[p + P_VX] += (def.gravityX + rx * radial - ry * tangent) * dt;
        pool[p + P_VY] += (def.gravityY + ry * radial + rx * tangent) * dt;
        const dx = pool[p + P_VX] * dt;
        const dy = pool[p + P_VY] * dt;
        if (dynamic !== 0) {
          // [:845587-845618]
          const gap = wrap180(dynamic - (Math.atan2(dy, dx) * 180) / Math.PI - pool[p + P_ROT]);
          pool[p + P_ROT] += gap * dt * DYNAMIC_ROTATION_RATE;
        }
        pool[p + P_X] += dx;
        pool[p + P_Y] += dy;
      }
      pool[p + P_AGE] += dt;
      const c = i * C_STRIDE;
      if (def.uniformColor) {
        // Every particle on the one ramp, by the share of its life gone.
        // [:845707-845725]
        const t = pool[p + P_AGE] * pool[p + P_INV_LIFE];
        for (let k = 0; k < 3; k++) colours[c + k] = clamp01(t * this.uniform[3 + k] + (1 - t) * this.uniform[k]);
      } else {
        for (let k = 0; k < 3; k++) colours[c + k] = clamp01(colours[c + k] + colours[c + 4 + k] * dt);
      }
      colours[c + 3] = clamp01(colours[c + 3] + colours[c + 7] * dt);
      pool[p + P_SIZE] = Math.max(0, pool[p + P_SIZE] + pool[p + P_D_SIZE] * dt);
      const rot = pool[p + P_ROT];
      if (rot > 360) pool[p + P_ROT] = rot - 360;
      else if (rot < 0) pool[p + P_ROT] = rot + 360;
      // Friction, after the move: a share of the speed, the size change and
      // the spin, per second. The speed is gravity mode's direction, which
      // radius mode never reads, so there it does nothing; P_VX holds the
      // spin rate in radius mode and must not be damped. [:845769-845790;
      // the radius branch :845620-845705 reads only +124 to +144]
      const fp = pool[p + P_FRICTION_P];
      if (fp !== 0 && !radius) {
        pool[p + P_VX] *= 1 - dt * fp;
        pool[p + P_VY] *= 1 - dt * fp;
      }
      const fs = pool[p + P_FRICTION_S];
      if (fs !== 0) pool[p + P_D_SIZE] *= 1 - dt * fs;
      const fr = pool[p + P_FRICTION_R];
      if (fr !== 0) pool[p + P_D_ROT] *= 1 - dt * fr;
      i++;
    }
  }

  /** Drops particle `i`: the last moves into its place, or all after it move down one. */
  private remove(i: number, keepOrder: boolean): void {
    const last = --this.live;
    if (last === i) return;
    if (keepOrder) {
      this.pool.copyWithin(i * P_STRIDE, (i + 1) * P_STRIDE, (last + 1) * P_STRIDE);
      this.colours.copyWithin(i * C_STRIDE, (i + 1) * C_STRIDE, (last + 1) * C_STRIDE);
    } else {
      this.pool.copyWithin(i * P_STRIDE, last * P_STRIDE, last * P_STRIDE + P_STRIDE);
      this.colours.copyWithin(i * C_STRIDE, last * C_STRIDE, last * C_STRIDE + C_STRIDE);
    }
  }

  /**
   * Writes this emitter's live particles into the instance buffer.
   *
   * The game hands each quad a colour scaled by the particle's fades and the
   * system's opacity (+726). Whether the particle's alpha is folded into that
   * colour as well (+584) was settled when the system took its texture, by
   * the blend it was made with: yes for a normal one, no for an additive
   * one, and an object's blending switching it later does not change it.
   * So an additive definition draws as an additive particle (BLEND.
   * ADD_PARTICLE), a normal one its object made additive as a sprite in an
   * additive batch (BLEND.ADD_SPRITE), a normal one as a sprite, which
   * multiplies the colour by its alpha in the shader, and an additive one its
   * object made normal with its colour as it is, under the premultiplied
   * art's ONE / ONE_MINUS_SRC_ALPHA (BLEND.STRAIGHT).
   * [updateQuadWithParticle :848040-848063; +584 is set only for a normal
   *  blend on premultiplied art, updateBlendFunc :844213-844239, called from
   *  setTexture, which particleFromStruct reaches through setDisplayFrame
   *  :44049, after setBlendAdditive (vfunc 632) :44041; blendModeChanged
   *  :297285-297296 sets the blend alone, and setBlendAdditive(false)
   *  :844274-844296 gives premultiplied art 1 / 771 and leaves +584]
   */
  bake(out: Float32Array, bytes: Uint8Array, at: number, quad: BakedQuad): number {
    const pool = this.pool;
    const colours = this.colours;
    const additive = this.additive;
    const straight = this.def.additive;
    const blend = !additive
      ? straight
        ? BLEND.STRAIGHT
        : BLEND.NORMAL
      : straight
        ? BLEND.ADD_PARTICLE
        : BLEND.ADD_SPRITE;
    const opacity = this.opacity;
    // A grouped emitter's particles live in its own space: from where they
    // started, through its turn and scale, onto where it is now.
    const grouped = this.grouped;
    const [na, nb, nc, nd] = this.node;
    for (let i = 0; i < this.live; i++) {
      const p = i * P_STRIDE;
      const c = i * C_STRIDE;
      const half = pool[p + P_SIZE] * 0.5;
      if (half <= 0) continue;
      const rad = (-pool[p + P_ROT] * Math.PI) / 180;
      const cos = Math.cos(rad) * half;
      const sin = Math.sin(rad) * half;
      const f = at * INSTANCE_FLOATS;
      if (grouped) {
        const lx = pool[p + P_X] - pool[p + P_START_X];
        const ly = pool[p + P_Y] - pool[p + P_START_Y];
        out[f] = na * cos + nc * sin;
        out[f + 1] = nb * cos + nd * sin;
        out[f + 2] = -na * sin + nc * cos;
        out[f + 3] = -nb * sin + nd * cos;
        out[f + 4] = this.x + na * lx + nc * ly;
        out[f + 5] = this.y + nb * lx + nd * ly;
      } else {
        out[f] = cos;
        out[f + 1] = sin;
        out[f + 2] = -sin;
        out[f + 3] = cos;
        out[f + 4] = pool[p + P_X];
        out[f + 5] = pool[p + P_Y];
      }
      out[f + 6] = quad.u0;
      out[f + 7] = quad.v0;
      out[f + 8] = quad.du;
      out[f + 9] = quad.dv;
      const k = fadeFactor(pool[p + P_AGE], pool[p + P_LIFE], pool[p + P_FADE_IN], pool[p + P_FADE_OUT]) * opacity;
      // A straight colour carries the fades and the system's opacity itself;
      // a premultiplied one gets them through its alpha in the shader.
      const tint = straight ? k : 1;
      const o = at * INSTANCE_BYTES;
      bytes[o + 40] = (colours[c] * tint * 255) | 0;
      bytes[o + 41] = (colours[c + 1] * tint * 255) | 0;
      bytes[o + 42] = (colours[c + 2] * tint * 255) | 0;
      bytes[o + 43] = (colours[c + 3] * k * 255) | 0;
      bytes[o + 44] = quad.sheet;
      bytes[o + 45] = quad.rotated;
      bytes[o + 46] = blend;
      bytes[o + 47] = 0;
      at++;
    }
    return at;
  }
}

/**
 * How far into its fades a particle is: up from 0 over the fade-in, down to 0
 * over the last `fadeOut` seconds of its life, 1 between.
 * [updateQuadWithParticle :848047, :848056]
 */
export function fadeFactor(age: number, lifeLeft: number, fadeIn: number, fadeOut: number): number {
  if (age < fadeIn) return age / fadeIn;
  if (lifeLeft < fadeOut) return lifeLeft / fadeOut;
  return 1;
}

/** A fade's length: at most `room`, and 0 when it or the room is 0 or less. [initParticle :844885-844933] */
function clampFade(v: number, room: number): number {
  if (Math.min(v, room) <= 0) return 0;
  return Math.min(v, room);
}

function wrap180(d: number): number {
  if (d > 180) return d - 360;
  if (d < -180) return d + 360;
  return d;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface BakedQuad {
  u0: number;
  v0: number;
  du: number;
  dv: number;
  sheet: number;
  rotated: number;
}

/** The order the emitters draw in: by z, then by their place at that z. */
function byPlace(a: Placed, b: Placed): number {
  return a.z - b.z || a.order - b.order;
}

/** What a placed emitter needs from its object beyond the definition. */
interface Placed {
  object: LevelObject;
  emitter: ParticleEmitter;
  quad: BakedQuad;
  /**
   * Where in the object layer the system draws (batchNodes), the draw layer
   * that z is in, and its place among the systems at that z: a Custom
   * Particles object's z order in its container, 0 for an object's own.
   */
  z: number;
  layer: number;
  order: number;
  claimed: boolean;
  /** How many Animate triggers had reached it the last time it looked. */
  animations: number;
  /** A free or relative emitter's object scale when last seen on screen, x then y, to tell a scale trigger. */
  seenScaleX: number;
  seenScaleY: number;
  /** A system the object's type hangs on it, with its record, or null for a Custom Particles object. */
  builtIn: { p: BuiltInParticle; record: ObjectRecord } | null;
  /** A one-shot system a Spawn Particle trigger made: it stays where it was put and goes once it is empty. */
  spawned?: boolean;
}

/** A Spawn Particle trigger's system, waiting for the next update to start it. */
interface SpawnRequest {
  object: LevelObject;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** What the live level tells the emitters each frame. */
export interface ParticleScene {
  /** The level's clock in seconds, for the emitters that restart on their own. */
  levelTime: number;
  /** The live colour table, with its group pulses, for the emitters that take their object's colours. */
  colors: ColorSource | null;
  /** How many Animate triggers have reached an object so far. */
  animationsOf(objectIndex: number): number;
  /**
   * Where an object has been carried to (TriggerRuntime.objectTransform):
   * false for one that has not moved. Absent, every emitter stays put.
   */
  objectTransform?(objectIndex: number, out: Float64Array): boolean;
  /**
   * Whether a group toggle has switched the object off
   * (TriggerRuntime.objectDisabled): it is not shown, so it has no system.
   * Absent, none is.
   */
  objectDisabled?(objectIndex: number): boolean;
  /**
   * The opacity the object was shown at this frame, 0..1, before its colour's
   * and its groups': its fade at the screen's edge or its enter effect's, 0
   * when it is not shown (DrawList.objectFade). Absent, every object is
   * shown in full.
   */
  objectFade?(objectIndex: number): number;
  /** A group's opacity from the Alpha triggers (TriggerRuntime.groupAlphaOf). Absent, every group's is 1. */
  groupAlphaOf?(group: number): number;
}

/**
 * At or under this opacity (of 255) an object's own particle system stops
 * emitting; over it, it starts again. [GameObject::updateParticleOpacity
 * :165124-165150]
 */
export const PARTICLE_OPACITY_CUTOFF = 50;

/**
 * GameObject::opacityModForMode for an object's main half: its colour's
 * opacity, as the game rounds it (channelOpacityMod, which its sprites take
 * too), times its groups' opacities, nothing at all once one of them is 0. A
 * channel of 0 or less has no opacity of its own.
 * [GameObject::opacityModForMode :172788-172808; groupOpacityMod
 *  :170161-170180]
 */
export function mainOpacityMod(object: LevelObject, channel: number, scene: Pick<ParticleScene, "colors" | "groupAlphaOf">): number {
  let mod = 1;
  if (channel > 0 && scene.colors) mod = channelOpacityMod(scene.colors.get(channel).a);
  const groupAlpha = scene.groupAlphaOf;
  if (groupAlpha && object.groups.length > 0) {
    let groups = 1;
    for (const g of object.groups) {
      groups *= groupAlpha(g);
      if (groups <= 0) return 0;
    }
    mod *= groups;
  }
  return mod;
}

/**
 * Every emitter a level places, stepped and drawn together.
 *
 * Only the emitters near the view run: a level carries up to a thousand of
 * them, a screen shows a handful, and an emitter that is off screen has nothing
 * worth simulating. Coming on screen is what the game calls claiming a
 * particle system, and going off hands it back, so an emitter is started
 * afresh each time. The live budget is shared, so one enormous emitter cannot
 * starve the rest.
 *
 * Each system draws among the blocks, not over the whole level, at a z of
 * its own between the object layer's batches: a Custom Particles object's in
 * its layer's container, by its z order there; an object's own one at the z
 * its type gave it, which is over all of B1 (batchNodes.ts). So the emitters
 * are kept in z order and baked as one run per z, which the scene draws
 * between the draw list's batches.
 * [gdp ParticleGameObject::addMainSpriteToParent :301723-301759 →
 *  GameObject::parentForZLayer(.., 4), the containers setupLayers makes
 *  :435227-435275; GJBaseGameLayer::createParticle :458906-458908 (the z as
 *  the system's tag) → claimParticle :431656-431700 (added to the object
 *  layer at its tag)]
 */
export class ParticleField {
  private readonly placed: Placed[] = [];
  private data = new Float32Array(MAX_LIVE * INSTANCE_FLOATS);
  private bytes = new Uint8Array(this.data.buffer);
  private lastCount = 0;
  /**
   * The last `update`'s instances by z, as DrawList.runZ/runStart/runCount:
   * one run per z drawn at, in order, and each draw layer's first run and
   * run count.
   */
  readonly runZ = new Int16Array(MAX_RUNS);
  readonly runStart = new Int32Array(MAX_RUNS);
  readonly runCount = new Int32Array(MAX_RUNS);
  readonly layerRunFirst = new Int32Array(LAYER_Z.length);
  readonly layerRuns = new Int32Array(LAYER_Z.length);
  runs = 0;
  /** The level time last seen; a respawn takes it back, and the emitters start over. */
  private lastTime = 0;
  /** Emitters that had no frame in the atlas, so the gap is counted. */
  readonly missingFrames: number;
  private readonly m9 = new Float64Array(9);
  private readonly scaleOut: [number, number] = [1, 1];
  /** The Spawn Particle trigger's systems, and every system in the order they draw. */
  private spawned: Placed[] = [];
  private drawOrder: Placed[] = this.placed;
  private pending: SpawnRequest[] = [];
  /** A Custom Particles object's definition and quad, read the first time a trigger spawns it. */
  private readonly spawnDefs = new Map<number, { def: ParticleDef; quad: BakedQuad } | null>();
  private spawnSeed = 0;

  /**
   * `zLayerOf` is an object's layer as the game reads it (key 24, else its
   * type's default), and `zOrderOf` its z order (key 25, else its type's
   * default); without them an emitter with no key 24 counts as B2, and one
   * with no key 25 as z order 0.
   */
  constructor(
    level: Level,
    private readonly atlas: AtlasSet,
    private readonly zLayerOf: (object: LevelObject) => number = (o) => effectiveZLayer(o.zLayer, 0),
    private readonly zOrderOf: (object: LevelObject) => number = (o) => effectiveZOrder(o.zOrder, 0),
  ) {
    let missing = 0;
    let index = 0;
    for (const object of level.objects) {
      // A hidden object (key 135) is never shown in play, and showing it is
      // the only place an object claims its particle system.
      // [GameObject::setVisible :164667-164690; activateObject :169451-169475]
      if (object.id !== CUSTOM_PARTICLE_ID || objectFlag(object, OBJECT_KEY.hide)) continue;
      const def = parseParticleString(object.props[145]);
      if (!def) continue;
      const found = atlas.frame(particleFrameName(def));
      if (!found) {
        missing++;
        continue;
      }
      const quad = frameQuad(found.atlas, found.frame, atlas.pxPerUnit);
      const emitter = new ParticleEmitter(def, object.x, object.y, index++, {
        animateOnTrigger: objectFlag(object, OBJECT_KEY.animateOnTrigger),
      });
      const z = containerZ(zLayerOf(object));
      this.placed.push({
        object,
        emitter,
        quad: {
          u0: quad.u0,
          v0: quad.v0,
          du: quad.du,
          dv: quad.dv,
          sheet: found.atlasIndex,
          rotated: quad.rotated ? 1 : 0,
        },
        z,
        layer: slotOfZ(z),
        order: zOrderOf(object),
        claimed: false,
        animations: 0,
        seenScaleX: 1,
        seenScaleY: 1,
        builtIn: null,
      });
    }
    // A container orders its systems by z order; stable, so the ones that
    // tie keep the order the level placed them in. [addMainSpriteToParent
    //  :301745-301758, addChild at getObjectZOrder]
    this.placed.sort(byPlace);
    this.missingFrames = missing;
  }

  /** Whether the built-in systems have been added (addBuiltIn). */
  get hasBuiltIn(): boolean {
    return this.builtInAdded;
  }
  private builtInAdded = false;

  /**
   * The systems the objects' own types carry (ObjectRecord.pt): one emitter
   * per object that has one, from its effect file with what customSetup
   * changed on it, drawn in the object layer at the z the type gave it
   * (BuiltInParticle.z), whatever layer the object is in. `effect` turns an
   * effect's name into its definition and its texture's name, and `quadFor`
   * that texture into a quad. An object hidden in play (key 135) never
   * claims one.
   * [gdp GameObject::createAndAddParticle :167739-167766 (its z, the 4th
   *  argument, becomes the system's tag in GJBaseGameLayer::createParticle
   *  :458906-458908); GJBaseGameLayer::claimParticle :431656-431700 (added to
   *  the object layer, +627, at that tag: the z - 1 GameObject::claimParticle
   *  :169099-169112 works out is never read, nor in the 2.2074 exe, VA
   *  0x140198dd5-0x140198ef8); GameObject::claimParticle :167570ff (what the
   *  object sets on the system as it comes on screen); setVisible
   *  :164660-164690]
   */
  addBuiltIn(
    level: Level,
    records: (id: number) => ObjectRecord | undefined,
    effect: (name: string) => { def: ParticleDef; texture: string } | null,
    quadFor: (texture: string) => BakedQuad | null,
  ): void {
    if (this.builtInAdded) return;
    this.builtInAdded = true;
    let index = this.placed.length;
    for (const object of level.objects) {
      const record = records(object.id);
      const p = record?.pt;
      if (!record || !p || objectFlag(object, OBJECT_KEY.hide)) continue;
      const found = effect(p.e);
      if (!found) continue;
      const base = found.def;
      const quad = quadFor(found.texture);
      if (!quad) continue;
      const def: ParticleDef = { ...base, positionType: p.pos };
      const colour = (c: BuiltInParticle["s"], own: [number, number, number, number]): [number, number, number, number] =>
        c ? [c[0], c[1], c[2], c[3] ?? own[3]] : own;
      def.startColor = colour(p.s, base.startColor);
      def.endColor = colour(p.en, base.endColor);
      const z = p.z ?? 0;
      this.placed.push({
        object,
        emitter: new ParticleEmitter(def, object.x, object.y, index++),
        quad,
        z,
        layer: slotOfZ(z),
        order: 0,
        claimed: false,
        animations: 0,
        seenScaleX: 1,
        seenScaleY: 1,
        builtIn: { p, record },
      });
    }
    this.placed.sort(byPlace);
    this.reorder();
  }

  /** The placed systems and the spawned ones, merged by z and place; the placed draw first on a tie. */
  private reorder(): void {
    this.drawOrder = this.spawned.length === 0 ? this.placed : [...this.placed, ...this.spawned].sort(byPlace);
  }

  /**
   * A Spawn Particle trigger's system for one Custom Particles object: a
   * fresh copy of it, at `x`, `y`, turned and scaled as given, started at
   * the next update and dropped once its burst is spent. One that would run
   * for ever runs out at once instead.
   * [gdp GJBaseGameLayer::spawnParticleTrigger :431365-431412 (a fresh
   *  system at the object's z layer and z order, its duration below 0 set
   *  to 0, then resumeSystem)]
   */
  spawn(object: LevelObject, x: number, y: number, rotation: number, scaleX: number, scaleY: number): void {
    this.pending.push({ object, x, y, rotation, scaleX, scaleY });
  }

  private startSpawned(r: SpawnRequest, scene: ParticleScene): void {
    let found = this.spawnDefs.get(r.object.index);
    if (found === undefined) {
      found = null;
      const def = parseParticleString(r.object.props[145]);
      const frame = def ? this.atlas.frame(particleFrameName(def)) : null;
      if (def && frame) {
        const q = frameQuad(frame.atlas, frame.frame, this.atlas.pxPerUnit);
        found = {
          def: { ...def, duration: Math.max(def.duration, 0) },
          quad: { u0: q.u0, v0: q.v0, du: q.du, dv: q.dv, sheet: frame.atlasIndex, rotated: q.rotated ? 1 : 0 },
        };
      }
      this.spawnDefs.set(r.object.index, found);
    }
    if (!found) return;
    const emitter = new ParticleEmitter(found.def, r.x, r.y, 0x10000 + this.spawnSeed++);
    const colours = objectColours(r.object, scene.colors);
    if (colours) emitter.objectBlend(colours.blending);
    emitter.claim(colours);
    emitter.restart();
    emitter.follow(r.x, r.y, r.rotation, r.scaleX, r.scaleY, r.scaleX < 0 || r.scaleY < 0);
    if (!emitter.grouped && r.scaleY !== 1) emitter.rescale(r.scaleY);
    const z = containerZ(this.zLayerOf(r.object));
    this.spawned.push({
      object: r.object,
      emitter,
      quad: found.quad,
      z,
      layer: slotOfZ(z),
      order: this.zOrderOf(r.object),
      claimed: true,
      animations: 0,
      seenScaleX: r.scaleX,
      seenScaleY: r.scaleY,
      builtIn: null,
      spawned: true,
    });
  }

  get emitterCount(): number {
    return this.placed.length;
  }

  get particleCount(): number {
    return this.lastCount;
  }

  reset(): void {
    this.lastTime = 0;
    for (const e of this.placed) {
      e.emitter.reset();
      e.claimed = false;
      e.animations = 0;
    }
    this.pending = [];
    if (this.spawned.length > 0) {
      this.spawned = [];
      this.reorder();
    }
  }

  /** Steps the emitters the camera can see and bakes them into one buffer, in z order. */
  update(dt: number, view: ViewBox, scene: ParticleScene): { data: Float32Array; count: number } {
    let budget = MAX_LIVE;
    let at = 0;
    this.layerRunFirst.fill(0);
    this.layerRuns.fill(0);
    this.runs = 0;
    const x0 = view.x0 - EMITTER_MARGIN;
    const x1 = view.x1 + EMITTER_MARGIN;
    const y0 = view.y0 - EMITTER_MARGIN;
    const y1 = view.y1 + EMITTER_MARGIN;
    if (scene.levelTime < this.lastTime) {
      // A respawn: everything starts over, and the Animate triggers that
      // fired before the point it went back to are not started again.
      this.reset();
      for (const e of this.placed) e.animations = scene.animationsOf(e.object.index);
    }
    this.lastTime = scene.levelTime;
    if (this.pending.length > 0) {
      for (const r of this.pending) this.startSpawned(r, scene);
      this.pending = [];
      this.reorder();
    }
    let spent = false;
    for (const e of this.drawOrder) {
      const emitter = e.emitter;
      if (e.spawned) {
        customOpacity(e.object, emitter, scene);
        budget = emitter.step(dt, budget);
        if (!emitter.running && emitter.count === 0) {
          spent = true;
          continue;
        }
        if (at + emitter.count > MAX_LIVE) break;
        const from = at;
        at = emitter.bake(this.data, this.bytes, at, e.quad);
        if (at > from) this.counted(e, from, at);
        continue;
      }
      const scale = this.follow(e, scene);
      // Off screen, or switched off by a group toggle: either way the object
      // is not shown and hands its system back. [GJBaseGameLayer::
      //  preUpdateVisibility :452902]
      const off = scene.objectDisabled ? scene.objectDisabled(e.object.index) : false;
      if (off || emitter.x < x0 || emitter.x > x1 || emitter.y < y0 || emitter.y > y1) {
        if (e.claimed) {
          emitter.reset();
          e.claimed = false;
        }
        continue;
      }
      // A built-in system takes its object's colour as the game sets it when
      // the object claims one, and again each frame the object is coloured.
      if (e.builtIn) {
        if (scene.colors) builtInColours(e.emitter, e.object, e.builtIn.p, e.builtIn.record, scene.colors);
        if (!e.claimed) {
          emitter.claim(null);
          e.claimed = true;
        }
        // The object's opacity, set on it every frame it is shown, starts and
        // stops its system; the particles out keep their own colours and
        // finish. [GameObject::setOpacity :167614-167703 → vfunc 820,
        //  updateParticleOpacity :165124-165150; the vtable's 812 is
        //  blendModeChanged and 816 updateParticleColor, :169322, :165366]
        emitter.setEmitting(builtInOpacity(e.object, e.builtIn.record, scene) > PARTICLE_OPACITY_CUTOFF);
        budget = emitter.step(dt, budget);
        if (at + emitter.count > MAX_LIVE) break;
        const from = at;
        at = emitter.bake(this.data, this.bytes, at, e.quad);
        if (at > from) this.counted(e, from, at);
        continue;
      }
      // The object's colours on the frame it comes on screen, then on every
      // frame after, as the game colours it: a colour trigger or a pulse
      // reaches the particles while they are out.
      const colours = objectColours(e.object, scene.colors);
      if (colours) emitter.objectBlend(colours.blending);
      if (!e.claimed) {
        emitter.claim(colours);
        e.claimed = true;
        e.seenScaleX = scale[0];
        e.seenScaleY = scale[1];
      } else {
        if (colours) emitter.recolour(colours);
        // Only a scale trigger's setScaleX and setScaleY reach a free or
        // relative emitter, and only while it is on screen; the claim itself
        // leaves its scale at 1. [applyParticleSettings :306209-306232]
        if (!emitter.grouped && (scale[0] !== e.seenScaleX || scale[1] !== e.seenScaleY)) {
          emitter.rescale(scale[1]);
          e.seenScaleX = scale[0];
          e.seenScaleY = scale[1];
        }
      }
      // An Animate trigger that reached it since it last looked, on screen
      // or off, starts an emitter with key 123 again. [EnhancedGameObject::
      //  animationTriggered :164755-164759 → triggerAnimation
      //  :620430-620444 (+1237, read by updateSyncedAnimation)]
      const n = scene.animationsOf(e.object.index);
      if (n > e.animations) emitter.animate();
      e.animations = n;
      // Its opacity never stops it; it dims every particle it has out.
      customOpacity(e.object, emitter, scene);
      // A frozen frame does not run the object's synced animation either.
      if (dt > 0) emitter.sync(scene.levelTime);
      budget = emitter.step(dt, budget);
      if (at + emitter.count > MAX_LIVE) break;
      const from = at;
      at = emitter.bake(this.data, this.bytes, at, e.quad);
      if (at > from) this.counted(e, from, at);
    }
    if (spent) {
      this.spawned = this.spawned.filter((e) => e.emitter.running || e.emitter.count > 0);
      this.reorder();
    }
    this.lastCount = at;
    return { data: this.data, count: at };
  }

  /** Files an emitter's instances, `from` to `at`, under its z's run, and that run under its draw layer. */
  private counted(e: Placed, from: number, at: number): void {
    const last = this.runs - 1;
    if (last >= 0 && this.runZ[last] === e.z) {
      this.runCount[last] += at - from;
      return;
    }
    if (this.runs >= MAX_RUNS) {
      this.runCount[last] += at - from;
      return;
    }
    const run = this.runs++;
    this.runZ[run] = e.z;
    this.runStart[run] = from;
    this.runCount[run] = at - from;
    if (this.layerRuns[e.layer]++ === 0) this.layerRunFirst[e.layer] = run;
  }

  /**
   * Puts an emitter where its object is now, turned and scaled as it is:
   * its own key 6, scales and flips, carried by its groups. Returns the
   * object's signed scale, x and y.
   */
  private follow(e: Placed, scene: ParticleScene): [number, number] {
    const o = e.object;
    const m = this.m9;
    const moved = scene.objectTransform ? scene.objectTransform(o.index, m) : false;
    const x = moved ? m[0] * o.x + m[2] * o.y + m[4] : o.x;
    const y = moved ? m[1] * o.x + m[3] * o.y + m[5] : o.y;
    const rotation = o.rotation + (moved ? m[6] : 0);
    const sx = (o.flipX ? -1 : 1) * o.scaleX * (moved ? m[7] : 1);
    const sy = (o.flipY ? -1 : 1) * o.scaleY * (moved ? m[8] : 1);
    const b = e.builtIn?.p;
    if (b) {
      // Its place is the object's plus the offset in the object's own space;
      // +920 keeps it unturned and +680 at a scale of 1.
      // [GameObject::setPosition :164602-164627; claimParticle :167625-167650]
      let px = x;
      let py = y;
      if (b.o) {
        const t = (rotation * Math.PI) / 180;
        const ox = b.o[0] * sx;
        const oy = b.o[1] * sy;
        px += ox * Math.cos(t) + oy * Math.sin(t);
        py += -ox * Math.sin(t) + oy * Math.cos(t);
      }
      e.emitter.follow(px, py, b.r0 ? 0 : rotation, b.s1 ? 1 : sx, b.s1 ? 1 : sy, !b.s1 && (o.flipX || o.flipY));
    } else {
      e.emitter.follow(x, y, rotation, sx, sy, o.flipX || o.flipY);
    }
    this.scaleOut[0] = sx;
    this.scaleOut[1] = sy;
    return this.scaleOut;
  }
}

/**
 * The opacity a built-in system's object hands updateParticleOpacity, 0..255:
 * what it is shown at (255, or its fade at the screen's edge), times its
 * type's own opacity (+948, 0.4 for a few decorations), times its main half's
 * colour and group opacity, rounded down as the game does; nothing for a
 * black object that blends. [GameObject::setOpacity :167614-167648, the
 * black check :167646-167647 (+740 is 2 for a black colour,
 * setObjectColor :165316-165360; +744 the main half blending);
 * updateVisibility :96001-96076 for what it is shown at; +948 is set by
 * setupCustomSprites, e.g. :614790 (ObjectRecord.a)]
 */
function builtInOpacity(object: LevelObject, record: ObjectRecord, scene: ParticleScene): number {
  let shown = Math.trunc(clamp01(scene.objectFade ? scene.objectFade(object.index) : 1) * 255);
  const own = record.a ?? 0;
  if (own > 0) shown = Math.trunc(shown * own);
  const channel = object.baseColor ?? record.bc ?? 0;
  let opacity = shown * mainOpacityMod(object, channel, scene);
  const colors = scene.colors;
  if (opacity > 0 && colors && channel > 0) {
    const resolved = colors.get(channel);
    const blends = channel === CHANNEL.P1 || channel === CHANNEL.P2 || channel === CHANNEL.LIGHT_BG || resolved.blending;
    if (blends) {
      const worn = objectColour(object, colors, channel, object.baseHsv, true);
      if (worn.r === 0 && worn.g === 0 && worn.b === 0) opacity = 0;
    }
  }
  return Math.trunc(opacity) & 255;
}

/**
 * What a Custom Particles object's opacity does to its system, each frame it
 * is shown: it ignores the screen's edge (+891) and has no type opacity, so
 * it is its main colour's and its groups' opacity alone. Every particle is
 * drawn times it, and with key 146 it is the alpha new particles start at.
 * Nothing stops the system: its own updateParticleOpacity is empty.
 * [ParticleGameObject::customSetup :298428-298446 (+891, +548);
 *  updateParticleOpacity :297208-297211; updateMainParticleOpacity
 *  :297309-297327; GameObject::setOpacity :167614-167645 (vfunc 824)]
 */
function customOpacity(object: LevelObject, emitter: ParticleEmitter, scene: ParticleScene): void {
  const opacity = Math.trunc(255 * mainOpacityMod(object, object.baseColor ?? CHANNEL.OBJECT, scene)) / 255;
  emitter.setSystemOpacity(opacity);
  if (objectFlag(object, OBJECT_KEY.particleUsesObjectColour)) emitter.setStartAlpha(opacity);
}

/**
 * What a built-in system's object does to its colours (+669): the object's
 * main colour, or its colour sprite's with +670, at full alpha to start and
 * clear to end. The fireballs (1583, 1586) run from the colour sprite's to
 * the main one's, and the bubble (1700) from the main one's, at the effect's
 * own alpha, to the colour sprite's. A system without +669 keeps what
 * customSetup gave it. [gdp GameObject::claimParticle :167655-167720;
 *  updateParticleColor :163689-163725]
 */
function builtInColours(emitter: ParticleEmitter, object: LevelObject, p: BuiltInParticle, record: ObjectRecord, colors: ColorSource): void {
  if (!p.c) return;
  const mainChannel = object.baseColor ?? record.bc ?? 0;
  const detailChannel = object.detailColor ?? record.dc;
  const main = objectColour(object, colors, mainChannel, object.baseHsv, true);
  const detail = detailChannel !== undefined ? objectColour(object, colors, detailChannel, object.detailHsv, false) : main;
  const rgb = (c: Rgb, a: number): number[] => [c.r / 255, c.g / 255, c.b / 255, a];
  if (object.id === 1583 || object.id === 1586) {
    emitter.setColours(rgb(detail, 1), rgb(main, 0));
  } else if (object.id === 1700) {
    emitter.setColours(rgb(main, emitter.def.startColor[3]), rgb(detail, 0));
  } else {
    const c = p.cs ? detail : main;
    emitter.setColours(rgb(c, 1), rgb(c, 0));
  }
}

/**
 * The colours an emitter takes from its object: key 146 makes them its start
 * and end colours, key 147 the ramp a uniform-colour definition shares (146
 * first). The main colour is the object's base channel, the detail colour its
 * detail channel or, with none named, the main one; each as the object wears
 * it, see objectColour. [ParticleGameObject::customObjectSetup :306001-306008
 * (146 → +669, 147 → +1536); applyParticleSettings :306240-306299]
 */
function objectColours(object: LevelObject, colors: ColorSource | null): ObjectColours | null {
  const useForRamp = objectFlag(object, OBJECT_KEY.particleUsesObjectColour);
  const useForUniform = objectFlag(object, OBJECT_KEY.particleUsesUniformColour);
  if (!colors || (!useForRamp && !useForUniform)) return null;
  const base = object.baseColor ?? CHANNEL.OBJECT;
  const main = objectColour(object, colors, base, object.baseHsv, true);
  const detail =
    object.detailColor !== null ? objectColour(object, colors, object.detailColor, object.detailHsv, false) : main;
  // Either half blending blends the object (+960: the main half's flag, else
  // the detail half's). P1, P2 and the light background always blend.
  // [addMainSpriteToParent :169317-169322; shouldBlendColor :166462-166495]
  const blends = (channel: number): boolean =>
    channel === CHANNEL.P1 || channel === CHANNEL.P2 || channel === CHANNEL.LIGHT_BG || colors.get(channel).blending;
  const blending = blends(base) || (object.detailColor !== null && blends(object.detailColor));
  return { main, detail, useForRamp, useForUniform, blending };
}

/**
 * One of an object's colours: its channel, then each pulse on each of its
 * groups that reaches that half of the object, then its own hue shift.
 * [GameObject::colorForMode :173028-173089: groupColor :173063, one
 *  GJEffectManager::colorForGroupID :477436 per group, then the hue shift,
 *  transformColor :173079]
 */
function objectColour(
  object: LevelObject,
  colors: ColorSource,
  channel: number,
  hsv: HsvShift | null,
  isMain: boolean,
): Rgb {
  let rgb: Rgb = colors.get(channel);
  if (colors.pulsesForGroup) {
    for (const g of object.groups) {
      const pulses = colors.pulsesForGroup(g);
      if (!pulses) continue;
      for (const p of pulses) {
        if (pulseAppliesTo(p, isMain)) rgb = colorForPulse(rgb, p, (n) => colors.get(n));
      }
    }
  }
  return applyHsv(rgb, hsv);
}
