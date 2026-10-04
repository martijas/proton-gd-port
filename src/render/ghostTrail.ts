// The Ghost Trail: the fading copies of the player that the Enable and
// Disable Ghost Trail triggers (32 and 33) turn on and off.
//
// The game does not draw a streak for these. It runs a GhostTrailEffect,
// which every 0.05 s takes a copy of the player's icon sprite — its frame as
// it is that moment, where the player is, turned as the player is — and lets
// it fade from 200 to nothing over 0.4 s while it shrinks to 0.6 of its size.
// The copies are drawn added in the player's strengthened colour 1, or, when
// colour 1 is black, laid over in black. Each copy goes into the object layer
// one under the player itself, so it lies over everything behind the player
// and under the player (OBJECT_Z.GHOST). Turning the effect off stops new
// copies; the ones already there fade out as they would have.
//
// The copies are taken on the simulation's tick and age with its clock, so
// the trail is the same however fast the machine draws and a pause holds it;
// once the player has died they go on fading with the frame, as the game's
// do under the death (render/scene.ts, `afterlife`).
// [gdp PlayerObject::toggleGhostEffect :147123-147209; GhostTrailEffect
//  ::trailSnapshot :59182-59340, runWithTarget :59433-59466, init
//  :59093-59107 (normal blend, 1 / 771), doBlendAdditive :59482-59487
//  (770 / 1); PlayLayer::toggleGhostEffect :92269-92276 (player 2 in a
//  dual)]

import { BLEND, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import { affine } from "../engine/math";
import type { GameMode } from "../level/types";
import type { Rgb } from "./colors";
import type { PlayerRenderer } from "./player";

/** How often a copy is taken. [toggleGhostEffect :147168-147176 (0.05)] */
export const GHOST_INTERVAL = 0.05;
/** How long a copy takes to fade. [:147172 (0.4) → +268] */
export const GHOST_LIFE = 0.4;
/** The opacity a copy starts at. [toggleGhostEffect :147162 (+304 = 200), set at :59317-59319] */
export const GHOST_OPACITY = 200;
/**
 * What a copy shrinks to over its life, as a share of its first size — and
 * then by the player's own scale once more, so a mini player's copies end at
 * 0.36 of their first size. [runWithTarget's a6 (0.6, :147174) → +272; trailSnapshot
 *  :59326-59337 (CCScaleTo to the copy's scale × +272 × +280)]
 */
export const GHOST_SHRINK = 0.6;
/** Copies alive at once: two players, eight a life each, with room to spare. */
const MAX_COPIES = 32;

/** One player as a copy sees it, at the moment it is taken. */
export interface GhostPlayer {
  x: number;
  y: number;
  /** Degrees, clockwise, as the player turns. */
  rotation: number;
  mode: GameMode;
  /** The player's size, 0.6 mini. */
  scale: number;
  dead: boolean;
  /** The colour the icon wears as colour 1, and the level's strengthened copy of it. */
  icon: Rgb;
  strong: Rgb;
}

interface Copy {
  frame: string;
  x: number;
  y: number;
  rotation: number;
  /** The scale it starts at, and the one it ends at. */
  from: number;
  to: number;
  colour: Rgb;
  blend: number;
  /** The clock when it was taken. */
  at: number;
}

/** The effect for one player: whether it runs, and its timer. */
interface Effect {
  on: boolean;
  /** Seconds banked towards the next copy; -1 just after it starts. */
  elapsed: number;
}

export class GhostTrail {
  private readonly copies: Copy[] = [];
  private readonly effects: Effect[] = [
    { on: false, elapsed: -1 },
    { on: false, elapsed: -1 },
  ];
  readonly data = new Float32Array(MAX_COPIES * INSTANCE_FLOATS);
  private readonly bytes = new Uint8Array(this.data.buffer);
  private count = 0;

  /** Drops every copy and stops both effects, so a restart starts clean. */
  reset(): void {
    this.copies.length = 0;
    for (const e of this.effects) {
      e.on = false;
      e.elapsed = -1;
    }
  }

  /**
   * One tick for player `which` (0 or 1): `on` is the triggers' switch, `dt`
   * the tick's length. A dead player's effect is stopped, as the game stops
   * it when the player is destroyed. [playerDestroyed :149957]
   */
  step(which: 0 | 1, on: boolean, player: GhostPlayer | null, dt: number, seconds: number, art: PlayerRenderer): void {
    const effect = this.effects[which];
    const running = on && player !== null && !player.dead;
    if (running !== effect.on) {
      // A new effect is scheduled afresh; the scheduler's first call only
      // starts the count. [runWithTarget :59457; cocos2d CCTimer::update]
      effect.on = running;
      effect.elapsed = -1;
    }
    if (!effect.on || !player) return;
    if (effect.elapsed < 0) {
      effect.elapsed = 0;
      return;
    }
    effect.elapsed += dt;
    // A little under the interval, so twelve ticks of 1/240 make one.
    if (effect.elapsed < GHOST_INTERVAL - 1e-9) return;
    effect.elapsed = 0;
    this.take(player, seconds, art);
  }

  /**
   * One copy: the icon sprite's frame at the player's position and turn, at
   * the sprite's own scale times the player's. A black colour 1 gives a
   * black copy laid over what is there; any other gives the strengthened
   * colour, added. [trailSnapshot :59235-59281 (the frame, blend, position,
   * flip, turn, colour and scale, added at the player's z − 1); toggleGhostEffect
   * :147152-147196; togglePlayerScale :150459-150461 (+280)]
   */
  private take(player: GhostPlayer, seconds: number, art: PlayerRenderer): void {
    const sprite = art.iconSprite(player.mode);
    if (!sprite) return;
    if (this.copies.length >= MAX_COPIES) this.copies.shift();
    const black = player.icon.r === 0 && player.icon.g === 0 && player.icon.b === 0;
    const from = sprite.scale * player.scale;
    this.copies.push({
      frame: sprite.frame,
      x: player.x,
      y: player.y,
      rotation: player.rotation,
      from,
      to: from * GHOST_SHRINK * player.scale,
      colour: black ? { r: 0, g: 0, b: 0 } : { ...player.strong },
      blend: black ? BLEND.NORMAL : BLEND.ADD_SPRITE,
      at: seconds,
    });
  }

  /**
   * Builds the copies still fading, oldest first, as each was added after
   * the last. Returns how many instances to draw.
   */
  build(seconds: number, art: PlayerRenderer): number {
    // Each copy is removed when its fade ends. [trailSnapshot :59320-59325]
    while (this.copies.length > 0 && seconds - this.copies[0].at >= GHOST_LIFE) this.copies.shift();
    let at = 0;
    for (const copy of this.copies) {
      const t = Math.min(1, Math.max(0, (seconds - copy.at) / GHOST_LIFE));
      // CCFadeTo sets a byte; CCScaleTo runs alongside it. [cocos2d
      // CCFadeTo::update, CCScaleTo::update]
      const opacity = Math.trunc(GHOST_OPACITY * (1 - t));
      if (opacity <= 0) continue;
      const scale = copy.from + (copy.to - copy.from) * t;
      const matrix = affine(copy.x, copy.y, copy.rotation, scale, scale);
      if (art.writeFrame(this.data, this.bytes, at, copy.frame, matrix, copy.colour, opacity / 255, copy.blend)) at++;
    }
    this.count = at;
    return at;
  }

  /** How many instances the last build wrote. */
  get instances(): number {
    return this.count;
  }
}
