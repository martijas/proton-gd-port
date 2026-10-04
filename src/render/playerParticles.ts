// The effects that follow the player: the dust under it, the puff when it
// lands, the ship's exhaust and the dash's spray.
//
// This is what a cube actually leaves behind in the game. It has no ribbon —
// `trail.ts` draws one for the wave and for a level that switches one on — and
// what reads as a trail in a clip is `dragEffect`: thirty small additive
// squares thrown backwards from the cube's feet while it runs.
//
// All four definitions ship already. They are cocos particle plists out of the
// install, built into `particles.json` beside the level-string ones, and they
// are written in the plist's own field names rather than the level string's, so
// they are converted here into the one definition the emitter understands.
// All four name `square.png`, which is on the interface's packed page, so they
// cost no texture unit of their own.

import type { ParticleFile } from "../assets/miscTypes";
import type { GameMode } from "../level/types";
import type { PlayerState } from "../physics/types";
import { INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import { ParticleEmitter, type BakedQuad, type ParticleDef } from "./particles";
import type { EffectQuad } from "./effects";

/** The four the player itself uses, by their name in `particles.json`. */
export const PLAYER_EFFECTS = {
  drag: "dragEffect",
  land: "landEffect",
  shipDrag: "shipDragEffect",
  dash: "dashEffect",
} as const;

/**
 * Where each effect sits, in units from the player's centre, with the sign
 * already turned over for a flipped player.
 *
 * `updatePlayerArt` puts the drag system at `(0, 2)` in the player's own space
 * every frame and gives the other three no position at all. The constant is
 * two; what it is two *from* is the player node's origin, which this port has
 * never had to know — it positions its own player by the centre.
 *
 * Reading it from the centre puts the dust at the cube's waist and reading the
 * feet as the floor line sprays it through the ground; both were tried against
 * the game and both are visibly wrong. Two above the feet is what is left, and
 * it is what the game shows. The two effects that do not touch the ground stay
 * on the body, because nothing observed says otherwise and a ship's exhaust
 * coming off the floor would be its own kind of wrong.
 * [gdp PlayerObject::updatePlayerArt, gd-ida-decomp.cpp:145484-145491;
 *  the same value once at creation, :162399 and :162416]
 */
const DRAG_ABOVE_FEET = 2;
/** Half the player's hitbox, which is square, and what mini multiplies it by. */
const PLAYER_HALF_SIZE = 15;
const MINI_SCALE = 0.6;

/** Half the player's size, as it stands. */
function halfSizeOf(state: PlayerState): number {
  return PLAYER_HALF_SIZE * (state.mini ? MINI_SCALE : 1);
}

/**
 * Which way the player is travelling: +1 forward through the level, -1 back.
 *
 * Not "left", which is what a level with a reverse portal in it would make a
 * liar of. In classic mode the direction is the reversed flag the portals set;
 * in platformer the player steers, so it is the sign of its own velocity, with
 * the flag as the answer for standing still. `mirrored` is deliberately not
 * part of this: a mirror portal turns the *view* over and leaves the player
 * advancing the same way in the world the particles live in.
 */
export function facingOf(state: PlayerState): number {
  if (state.xVel > 0) return 1;
  if (state.xVel < 0) return -1;
  return state.reversed ? -1 : 1;
}
/** How long the landing burst is left running before it is switched off again. */
const LAND_BURST = 0.25;

type PlistFields = Record<string, number | string | boolean>;

function num(p: PlistFields, key: string, fallback = 0): number {
  const raw = p[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Turns a cocos particle plist into the definition the emitter runs.
 *
 * cocos has no emission rate field: it emits `maxParticles` over one lifetime,
 * which is the rate every plist implies. The fades are a Geometry Dash addition
 * to the format that a plist from the install does not carry, so they are zero
 * and the particle's own colour ramp does the work.
 */
export function defFromPlist(p: PlistFields): ParticleDef {
  const life = Math.max(0.001, num(p, "particleLifespan"));
  return {
    maxParticles: num(p, "maxParticles"),
    duration: num(p, "duration", -1),
    life: num(p, "particleLifespan"),
    lifeVar: num(p, "particleLifespanVariance"),
    emissionRate: num(p, "maxParticles") / life,
    angle: num(p, "angle"),
    angleVar: num(p, "angleVariance"),
    speed: num(p, "speed"),
    speedVar: num(p, "speedVariance"),
    posVarX: num(p, "sourcePositionVariancex"),
    posVarY: num(p, "sourcePositionVariancey"),
    gravityX: num(p, "gravityx"),
    gravityY: num(p, "gravityy"),
    radialAccel: num(p, "radialAcceleration"),
    radialAccelVar: num(p, "radialAccelVariance"),
    tangentialAccel: num(p, "tangentialAcceleration"),
    tangentialAccelVar: num(p, "tangentialAccelVariance"),
    startSize: num(p, "startParticleSize"),
    startSizeVar: num(p, "startParticleSizeVariance"),
    startSpin: num(p, "rotationStart"),
    startSpinVar: num(p, "rotationStartVariance"),
    startColor: [
      num(p, "startColorRed"),
      num(p, "startColorGreen"),
      num(p, "startColorBlue"),
      num(p, "startColorAlpha"),
    ],
    startColorVar: [
      num(p, "startColorVarianceRed"),
      num(p, "startColorVarianceGreen"),
      num(p, "startColorVarianceBlue"),
      num(p, "startColorVarianceAlpha"),
    ],
    endSize: num(p, "finishParticleSize"),
    endSizeVar: num(p, "finishParticleSizeVariance"),
    endSpin: num(p, "rotationEnd"),
    endSpinVar: num(p, "rotationEndVariance"),
    endColor: [
      num(p, "finishColorRed"),
      num(p, "finishColorGreen"),
      num(p, "finishColorBlue"),
      num(p, "finishColorAlpha"),
    ],
    endColorVar: [
      num(p, "finishColorVarianceRed"),
      num(p, "finishColorVarianceGreen"),
      num(p, "finishColorVarianceBlue"),
      num(p, "finishColorVarianceAlpha"),
    ],
    fadeIn: 0,
    fadeInVar: 0,
    fadeOut: 0,
    fadeOutVar: 0,
    startRadius: num(p, "maxRadius"),
    startRadiusVar: num(p, "maxRadiusVariance"),
    endRadius: num(p, "minRadius"),
    endRadiusVar: 0,
    rotatePerSecond: num(p, "rotatePerSecond"),
    rotatePerSecondVar: num(p, "rotatePerSecondVariance"),
    emitterMode: num(p, "emitterType"),
    positionType: 0,
    // 770 to 1 is GL_SRC_ALPHA to GL_ONE, which is what all four of these use.
    additive: num(p, "blendFuncDestination") === 1,
    spinRelative: false,
    textureIndex: 0,
    sizeRelative: false,
    radiusRelative: false,
    rotationIsDir: false,
    dynamicRotation: false,
    uniformColor: false,
    frictionP: 0,
    frictionPVar: 0,
    frictionS: 0,
    frictionSVar: 0,
    frictionR: 0,
    frictionRVar: 0,
    respawn: 0,
    respawnVar: 0,
    orderSensitive: false,
    startRGBVarSync: false,
    endRGBVarSync: false,
  };
}

/** The modes that trail exhaust rather than kick up dust. */
const EXHAUST_MODES: ReadonlySet<GameMode> = new Set<GameMode>(["ship", "ufo", "swing"]);

interface Slot {
  emitter: ParticleEmitter;
  /**
   * Drawn over the player rather than under it. The landing puffs and the
   * ship's exhaust sit at z 61 among the object layer's children, the dust and
   * the dash spray at 39, and the player at 59 between them.
   * [gdp PlayerObject::addAllParticles :141835-141880; which system is which,
   *  PlayerObject::init :162364-162512]
   */
  over: boolean;
  /** The plist's own gravity and emission angle, before the player's are applied. */
  fallsAt: number;
  aimedAt: number;
  /** Whether it should be emitting right now, given the player's state. */
  on(state: PlayerState, landing: boolean): boolean;
  /** Where it sits relative to the player. */
  offset(state: PlayerState, flipped: boolean): { x: number; y: number };
}

export class PlayerParticles {
  private slots: Slot[] = [];
  private land: Slot | null = null;
  private wasOnGround = false;
  private wasFlipped = false;
  private landFor = 0;
  private quad: BakedQuad | null = null;
  private count = 0;
  private under = 0;
  data = new Float32Array(1);
  private bytes = new Uint8Array(this.data.buffer);

  /** Builds the four emitters. `quad` is the art all of them are drawn with. */
  load(file: ParticleFile, quad: EffectQuad): void {
    const make = (name: string, index: number): ParticleEmitter | null => {
      const effect = file.effects[name];
      return effect ? new ParticleEmitter(defFromPlist(effect), 0, 0, index) : null;
    };
    // The offset turns over with the player, feet included: a child node of a
    // flipped player is flipped with it.
    const at = (from: (state: PlayerState) => number, behind = false) =>
      (state: PlayerState, flipped: boolean): { x: number; y: number } => ({
        // Behind means behind the way it is going, so a reverse portal moves
        // the dust to the other side of the player rather than leaving it
        // streaming out in front.
        x: state.x - (behind ? facingOf(state) * halfSizeOf(state) : 0),
        y: state.y + (flipped ? -from(state) : from(state)),
      });
    const justBehindAndAboveFeet = at((state) => -(halfSizeOf(state) - DRAG_ABOVE_FEET), true);
    const feet = at((state) => -halfSizeOf(state));
    const body = at(() => 0);
    const behindBody = at(() => 0, true);

    const land = wrap(make(PLAYER_EFFECTS.land, 2), (_s, landing) => landing, feet, true);
    const built: Array<Slot | null> = [
      wrap(make(PLAYER_EFFECTS.drag, 1), (s) => grounded(s.mode) && s.onGround && !s.dashing, justBehindAndAboveFeet, false),
      // A landing puff is the puff of hitting the ground, so it comes off the
      // part that hit it.
      land,
      // Exhaust comes out of the back of the ship for the same reason.
      wrap(make(PLAYER_EFFECTS.shipDrag, 3), (s) => EXHAUST_MODES.has(s.mode) && !s.onGround, behindBody, true),
      wrap(make(PLAYER_EFFECTS.dash, 4), (s) => s.dashing, body, false),
    ];
    this.slots = built.filter((s): s is Slot => s !== null);
    this.land = land;
    this.quad = { u0: quad.u0, v0: quad.v0, du: quad.du, dv: quad.dv, sheet: quad.unit, rotated: 0 };
    const cap = this.slots.reduce((n, s) => n + s.emitter.capacity, 0);
    this.data = new Float32Array(Math.max(1, cap) * INSTANCE_FLOATS);
    this.bytes = new Uint8Array(this.data.buffer);
  }

  get ready(): boolean {
    return this.quad !== null;
  }

  reset(): void {
    for (const slot of this.slots) slot.emitter.reset();
    this.wasOnGround = false;
    this.wasFlipped = false;
    this.landFor = 0;
    this.count = 0;
    this.under = 0;
    for (const slot of this.slots) {
      slot.emitter.def.gravityY = slot.fallsAt;
      slot.emitter.def.angle = slot.aimedAt;
    }
  }

  /**
   * Steps whichever effects the player's state calls for and bakes them, the
   * ones drawn under the player first: `underCount` instances, then the rest.
   *
   * An effect that has been switched off is still stepped with the real clock:
   * what stops is the emitting, so the particles already in the air finish
   * their own lives rather than vanishing — or, worse, hanging there — the
   * moment the cube leaves the ground.
   */
  update(state: PlayerState, dt: number, flipped: boolean): number {
    this.count = 0;
    this.under = 0;
    const quad = this.quad;
    if (!quad) return 0;

    // The landing puff is a burst: its plist gives it two hundredths of a
    // second of duration, so it is restarted on the tick the player touches
    // down and left to finish.
    if (!this.wasOnGround && state.onGround) {
      if (this.land) this.land.emitter.reset();
      this.landFor = LAND_BURST;
    }
    this.wasOnGround = state.onGround;
    if (this.landFor > 0) this.landFor -= dt;

    // The game re-signs these effects with the player's own gravity every
    // frame. Both halves turn over together: upside down the dust is thrown
    // away from the ceiling the player is standing on and falls back toward
    // it, which is the same picture as upright.
    // [gdp updatePlayerArt, gd-ida-decomp.cpp:145477-145482 — CCPoint(0, -300 *
    //  flipMod) for the gravity, and :145463-145473 for the angle]
    if (flipped !== this.wasFlipped) {
      this.wasFlipped = flipped;
      for (const slot of this.slots) {
        slot.emitter.def.gravityY = flipped ? -slot.fallsAt : slot.fallsAt;
        slot.emitter.def.angle = flipped ? -slot.aimedAt : slot.aimedAt;
      }
    }

    let budget = this.data.length / INSTANCE_FLOATS;
    for (const slot of this.slots) {
      const on = slot.on(state, this.landFor > 0);
      if (!on && slot.emitter.count === 0) continue;
      if (on) {
        // Only a running emitter follows the player. Particles keep the
        // position they were born at, so the ones already out stay put.
        const where = slot.offset(state, flipped);
        slot.emitter.x = where.x;
        slot.emitter.y = where.y;
      }
      budget = slot.emitter.step(dt, budget, on);
    }
    let at = 0;
    for (const slot of this.slots) {
      if (!slot.over && slot.emitter.count > 0) at = slot.emitter.bake(this.data, this.bytes, at, quad);
    }
    this.under = at;
    for (const slot of this.slots) {
      if (slot.over && slot.emitter.count > 0) at = slot.emitter.bake(this.data, this.bytes, at, quad);
    }
    this.count = at;
    return at;
  }

  get instances(): number {
    return this.count;
  }

  /** How many of the last `update`'s instances are drawn under the player; the rest go over it. */
  get underCount(): number {
    return this.under;
  }
}

/** True for the modes that run along a surface rather than fly. */
function grounded(mode: GameMode): boolean {
  return mode === "cube" || mode === "ball" || mode === "robot" || mode === "spider";
}

function wrap(
  emitter: ParticleEmitter | null,
  on: Slot["on"],
  offset: Slot["offset"],
  over: boolean,
): Slot | null {
  return emitter ? { emitter, over, fallsAt: emitter.def.gravityY, aimedAt: emitter.def.angle, on, offset } : null;
}
