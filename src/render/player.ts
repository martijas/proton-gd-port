// The player: the icon layers, the vehicle that carries them, and the two
// skeletal modes.
//
// An icon is a stack of layers drawn at one origin — the shape, the second
// colour, a fixed-colour detail, and an outline behind it all — and the trim
// offsets stored with each frame are what line them up. The flying modes carry
// the cube inside them, at a scale and offset the game hard-codes per mode; the
// robot and the spider are not sprites at all but a handful of limbs moved
// about by an AnimDesc frame.
//
// Everything here writes into the same 48-byte instance layout the level uses,
// so the player is part of the same draw call machinery rather than a special
// case in the batcher.

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import { affine, apply, compose, type Affine } from "../engine/math";
import { animFrame, partOf, type AnimEntity, type AnimSet } from "../assets/anims";
import type { IconSet } from "../assets/icons";
import type { IconDef, IconKind, IconLayer } from "../assets/iconTypes";
import { ICON_LAYER_ORDER } from "../assets/iconTypes";
import type { GameMode } from "../level/types";
import type { PlayerState } from "../physics/types";
import { frameQuad } from "./frameQuad";
import { playerChannelColours, type Rgb } from "./colors";

/** The most instances one player can need: the spider's limbs, three layers each. */
const MAX_SPRITES = 96;
/** MINI_SCALE in the simulation; the sprite shrinks with the hitbox. */
const MINI_SCALE = 0.6;

/**
 * Where each vehicle sits and where the cube rides inside it. Straight out of
 * PlayerObject::toggleFlyMode and toggleBirdMode: the ship drops 5 units and
 * holds the cube 5 up at 0.55, the UFO drops 7 and does the same, and the
 * jetpack stays put with the cube up and forward at 0.6.
 * [gdp PlayerObject::toggleFlyMode, gd-ida-decomp.cpp:152826-152856;
 *  toggleBirdMode :152939-152952]
 */
export interface Vehicle {
  kind: IconKind;
  /** Offset of the vehicle sprite itself. */
  y: number;
  /** The cube it carries, or null when it carries none. */
  rider: { x: number; y: number; scale: number } | null;
}

export const VEHICLES: Partial<Record<GameMode, Vehicle>> = {
  ship: { kind: "ship", y: -5, rider: { x: 0, y: 5, scale: 0.55 } },
  ufo: { kind: "ufo", y: -7, rider: { x: 0, y: 5, scale: 0.55 } },
};

/** Which icon kind draws each mode, for the modes that are one sprite. */
const SIMPLE_KIND: Partial<Record<GameMode, IconKind>> = {
  cube: "cube",
  ball: "ball",
  wave: "wave",
  swing: "swing",
};

/** The two skeletal modes and the animation entity that drives each. */
const SKELETAL: Partial<Record<GameMode, { kind: IconKind; entity: string }>> = {
  robot: { kind: "robot", entity: "Robot" },
  spider: { kind: "spider", entity: "Spider" },
};

/** Which icon number each kind draws. Goal 5's icon kit will own this. */
export interface IconChoice {
  cube: number;
  ship: number;
  ball: number;
  ufo: number;
  wave: number;
  robot: number;
  spider: number;
  swing: number;
  jetpack: number;
}

/** The game's own starting icons, which is what a fresh save gets. */
export const DEFAULT_ICONS: IconChoice = {
  cube: 1,
  ship: 1,
  ball: 1,
  ufo: 1,
  wave: 1,
  robot: 1,
  spider: 1,
  swing: 1,
  jetpack: 1,
};

/**
 * A colour dark enough that the game turns the outline on by itself, so the
 * icon does not disappear into a dark background. [guess: the icon kit's own
 * behaviour; the exact threshold is not established]
 */
const DARK_SUM = 100;

export class PlayerRenderer {
  private icons: IconSet | null = null;
  private anims: AnimSet | null = null;
  private readonly entities = new Map<string, AnimEntity>();
  /** Icon page index to the texture unit it is bound to. */
  private units = new Map<number, number>();
  readonly data = new Float32Array(MAX_SPRITES * INSTANCE_FLOATS);
  private readonly bytes = new Uint8Array(this.data.buffer);
  private at = 0;
  choice: IconChoice = { ...DEFAULT_ICONS };
  /** Draw the outline layer. Off unless the colours need it. */
  glow = false;
  /** The outline's colour for the build in progress: see build. */
  private glowTint: Rgb = { r: 255, g: 255, b: 255 };

  get ready(): boolean {
    return this.icons !== null;
  }

  async load(icons: IconSet, anims: AnimSet): Promise<void> {
    this.icons = icons;
    this.anims = anims;
    for (const { entity } of Object.values(SKELETAL)) {
      const pending = anims.entity(entity);
      if (pending) this.entities.set(entity, await pending);
    }
  }

  /** The loaded animation for a skeletal kind, for a menu that wants to pose one. */
  entityFor(kind: IconKind): AnimEntity | undefined {
    const skeletal = kind === "robot" ? SKELETAL.robot : kind === "spider" ? SKELETAL.spider : undefined;
    return skeletal ? this.entities.get(skeletal.entity) : undefined;
  }

  /** The icon pages a mode needs, at most two: the vehicle and its rider. */
  pagesFor(mode: GameMode): number[] {
    const icons = this.icons;
    if (!icons) return [];
    const out: number[] = [];
    const add = (kind: IconKind, id: number): void => {
      const icon = icons.icon(kind, id);
      if (icon && !out.includes(icon.page)) out.push(icon.page);
    };
    const vehicle = VEHICLES[mode];
    const skeletal = SKELETAL[mode];
    if (vehicle) {
      add(vehicle.kind, this.choice[vehicle.kind]);
      if (vehicle.rider) add("cube", this.choice.cube);
    } else if (skeletal) {
      add(skeletal.kind, this.choice[skeletal.kind]);
    } else {
      const kind = SIMPLE_KIND[mode] ?? "cube";
      add(kind, this.choice[kind]);
    }
    return out;
  }

  /** Told by the scene which texture unit each page landed on. */
  setUnits(units: Map<number, number>): void {
    this.units = units;
  }

  /**
   * Builds the player's sprites. `seconds` drives the skeletal animations and
   * comes from the simulation's tick, so a replay animates identically.
   * Returns how many instances were written into `data`.
   */
  build(state: PlayerState, p1: Rgb, p2: Rgb, seconds: number): number {
    this.at = 0;
    const icons = this.icons;
    if (!icons || state.dead) return 0;
    const scale = state.mini ? MINI_SCALE : 1;
    const body = affine(
      state.x,
      state.y,
      state.rotation,
      scale * (state.mirrored ? -1 : 1),
      scale * (state.flipped ? -1 : 1),
    );
    const glow = this.glow || p1.r + p1.g + p1.b < DARK_SUM;
    // The outline wears the strengthened colour 2, worked out from the icon's
    // own pair the way the level's P2 is (a black colour handing over
    // included), so player 2, whose pair is the other way round, gets its
    // own. The game's custom glow colour would replace it; the port has none.
    // [gdp PlayerObject::updateGlowColor :146119-146173, then the glow sprite
    //  (+376, player_%02d_glow_001.png at :146450-146465) and the robot's and
    //  spider's glow :146248-146277]
    this.glowTint = playerChannelColours(p1, p2).p2;

    const vehicle = VEHICLES[state.mode];
    const skeletal = SKELETAL[state.mode];
    if (vehicle) {
      this.drawIcon(vehicle.kind, this.choice[vehicle.kind], compose(body, affine(0, vehicle.y, 0, 1, 1)), p1, p2, glow);
      if (vehicle.rider) {
        const r = vehicle.rider;
        this.drawIcon("cube", this.choice.cube, compose(body, affine(r.x, r.y, 0, r.scale, r.scale)), p1, p2, glow);
      }
    } else if (skeletal) {
      this.drawSkeleton(skeletal.kind, skeletal.entity, state, body, p1, p2, glow, seconds);
    } else {
      const kind = SIMPLE_KIND[state.mode] ?? "cube";
      this.drawIcon(kind, this.choice[kind], body, p1, p2, glow);
    }
    return this.at;
  }

  private drawIcon(kind: IconKind, id: number, matrix: Affine, p1: Rgb, p2: Rgb, glow: boolean): void {
    const icons = this.icons;
    if (!icons) return;
    const icon = icons.icon(kind, id);
    if (!icon) return;
    for (const role of ICON_LAYER_ORDER) {
      if (role === "glow" && !glow) continue;
      for (const layer of icon.layers) {
        if (layer.role !== role) continue;
        this.push(layer, matrix, p1, p2);
      }
    }
  }

  /**
   * The robot and the spider, whose limbs come from an AnimDesc frame. The
   * animation names icon 01's textures; the part number is what carries over,
   * so somebody else's robot uses the same motion with its own limbs.
   */
  private drawSkeleton(
    kind: IconKind,
    entityName: string,
    state: PlayerState,
    body: Affine,
    p1: Rgb,
    p2: Rgb,
    glow: boolean,
    seconds: number,
  ): void {
    const icons = this.icons;
    const entity = this.entities.get(entityName);
    if (!icons || !entity) {
      // No animation data: fall back to the standing pose so the player is at
      // least visible rather than missing.
      this.drawIcon(kind, this.choice[kind], body, p1, p2, glow);
      return;
    }
    const icon = icons.icon(kind, this.choice[kind]);
    if (!icon) return;
    const clip = clipFor(state, entity);
    const anim = entity.animations[clip];
    const step = anim && anim.delay > 0 ? Math.floor(seconds / anim.delay) : 0;
    const parts = animFrame(entity, clip, step);
    if (!parts) {
      this.drawIcon(kind, this.choice[kind], body, p1, p2, glow);
      return;
    }
    const ordered = [...parts].sort((a, b) => a.z - b.z);
    for (const part of ordered) {
      const local = compose(body, affine(part.x, part.y, part.rot, part.sx, part.sy));
      const number = partOf(part.tex);
      for (const role of ICON_LAYER_ORDER) {
        if (role === "glow" && !glow) continue;
        for (const layer of icon.layers) {
          if (layer.role !== role || layer.part !== number) continue;
          this.push(layer, local, p1, p2);
        }
      }
    }
  }

  private push(layer: IconLayer, matrix: Affine, p1: Rgb, p2: Rgb): void {
    if (this.at >= MAX_SPRITES) return;
    // The shape follows colour 1, the second layer colour 2 and the outline
    // the strengthened colour 2, and the fixed detail and the UFO's canopy are
    // drawn as they are painted.
    const tint =
      layer.role === "base"
        ? p1
        : layer.role === "secondary"
          ? p2
          : layer.role === "glow"
            ? this.glowTint
            : { r: 255, g: 255, b: 255 };
    if (this.writeFrame(this.data, this.bytes, this.at, layer.n, matrix, tint, 1, BLEND.NORMAL)) this.at++;
  }

  /**
   * One icon frame as an instance at `at` of `data`, placed by `matrix`, in
   * `tint` at `alpha` with `blend`. False when the frame or its page is not
   * at hand, and nothing was written.
   */
  writeFrame(data: Float32Array, bytes: Uint8Array, at: number, frame: string, matrix: Affine, tint: Rgb, alpha: number, blend: number): boolean {
    const icons = this.icons;
    if (!icons) return false;
    const found = icons.frame(frame);
    if (!found) return false;
    const unit = this.units.get(found.page);
    if (unit === undefined) return false;
    const quad = frameQuad(found.atlas, found.frame, icons.pxPerUnit);
    const centre = apply(matrix, quad.cx, quad.cy);
    const f = at * INSTANCE_FLOATS;
    data[f] = matrix.a * quad.hw;
    data[f + 1] = matrix.b * quad.hw;
    data[f + 2] = matrix.c * quad.hh;
    data[f + 3] = matrix.d * quad.hh;
    data[f + 4] = centre.x;
    data[f + 5] = centre.y;
    data[f + 6] = quad.u0;
    data[f + 7] = quad.v0;
    data[f + 8] = quad.du;
    data[f + 9] = quad.dv;
    const o = at * INSTANCE_BYTES;
    bytes[o + 40] = tint.r;
    bytes[o + 41] = tint.g;
    bytes[o + 42] = tint.b;
    bytes[o + 43] = Math.round(alpha * 255);
    bytes[o + 44] = unit;
    bytes[o + 45] = quad.rotated ? 1 : 0;
    bytes[o + 46] = blend;
    bytes[o + 47] = 0;
    return true;
  }

  /**
   * The frame the player's icon sprite shows in `mode`, and that sprite's
   * own scale inside the player: the one sprite the Ghost Trail copies. It is
   * the shape layer of what the mode draws — the cube's, the ball's, the
   * wave's, the swing's — and the cube's again in the ship and the UFO, at
   * the size it rides there. The robot and the spider hide it, showing the
   * first limb's frame. [gdp PlayerObject::init :162206-162207 (+1492, the
   *  icon sprite, z 1); updatePlayerRollFrame :146495-146571, updatePlayerDartFrame
   *  :146682-146761 and updatePlayerSwingFrame :146587-146666 (its frame);
   *  toggleFlyMode :152848 and toggleBirdMode :152943 (0.55);
   *  toggleRobotMode :153234-153256 and toggleSpiderMode :152733-152752
   *  (the first limb's frame, then hidden)]
   */
  iconSprite(mode: GameMode): { frame: string; scale: number } | null {
    const icons = this.icons;
    if (!icons) return null;
    const vehicle = VEHICLES[mode];
    const skeletal = SKELETAL[mode];
    const kind: IconKind = vehicle ? "cube" : skeletal ? skeletal.kind : (SIMPLE_KIND[mode] ?? "cube");
    const icon = icons.icon(kind, this.choice[kind]);
    if (!icon) return null;
    const base = icon.layers.find((l) => l.role === "base" && (l.part === undefined || l.part === 1));
    if (!base) return null;
    return { frame: base.n, scale: vehicle?.rider ? vehicle.rider.scale : 1 };
  }
}

/**
 * Which clip a skeletal mode is playing. The robot runs on the ground, and in
 * the air it has a rising and a falling loop; the spider has no jump of its own
 * and falls instead. Clip names come straight from the animation file, so a
 * missing one falls back to whatever the entity calls its resting pose.
 */
export function clipFor(state: Pick<PlayerState, "onGround" | "yVel" | "flipped">, entity: AnimEntity): string {
  const has = (name: string): boolean => entity.animations[name] !== undefined;
  if (state.onGround) {
    if (has("run")) return "run";
  } else if (state.yVel > 0 !== state.flipped) {
    if (has("jump_loop")) return "jump_loop";
    if (has("jump")) return "jump";
  } else if (has("fall_loop")) {
    return "fall_loop";
  }
  if (has("idle")) return "idle";
  return Object.keys(entity.animations)[0] ?? "idle";
}
