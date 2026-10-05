// The shape of assets/objects.json: one record per object id, carrying both
// what the simulation needs and what the renderer needs.
//
// Keys are short because there are four thousand of them and the file is
// fetched on every load; the comments carry the meaning. Anything absent means
// "default", so a plain solid block is a handful of bytes.
//
// Units: offsets and sizes are GD units with y up (one block is 30). Frame
// names are the game's own, resolvable through the atlas index.

import type { Hitbox, ObjectKind, OrbType, PadType, PortalEffect } from "../physics/types";

/** Which colour channel a sprite follows: base, detail, or the black channel. */
export type ColorType = "B" | "D" | "K";

export interface ChildRecord {
  /** Frame name; guaranteed to exist in the atlas index the build validated against. */
  f: string;
  /** Offset from the parent's centre. */
  dx: number;
  dy: number;
  /** Draw order within the object; negative is behind the main sprite. */
  z: number;
  /** Degrees, clockwise positive, like cocos. */
  rot?: number;
  /** Scale, with a flip folded in as a negative sign (unless the child is anchored, see fx). */
  sx?: number;
  sy?: number;
  /**
   * Where the child's anchor sits in its frame, less the centre, as a share of
   * the frame's untrimmed size (cocos anchorPoint − 0.5): the child's position
   * is where that point of the sprite lands, and its scale and turn act about
   * it. Absent is the centre. [GameObject::setupCustomSprites :609992-610030,
   *  :610143-610190]
   */
  ax?: number;
  ay?: number;
  /**
   * A texture flip (CCSprite::setFlipX/Y), which mirrors the sprite inside its
   * own box and leaves the anchor where it is. Folded into sx/sy for a centred
   * child, where the two are the same; kept apart for an anchored one, where
   * they are not.
   */
  fx?: 1;
  fy?: 1;
  ct?: ColorType;
  /** 0..1; absent means opaque. */
  a?: number;
  /** Glow frame, when the game has one. */
  g?: string;
  /** Additive blend. */
  bl?: 1;
  /**
   * The game makes this sprite and never draws it (CCSprite's don't-draw
   * flag, +471): only its children show. It is the colour sprite of the sets
   * that hang their visible colour art on a child of it, often at another
   * scale. [setupCustomSprites, e.g. :612779-612787, :610199-610215]
   */
  dd?: 1;
  /** How far its top corners are lowered (Cut). */
  cut?: Cut;
  ch?: ChildRecord[];
}

/**
 * How far a sprite's top-left and top-right corners are lowered, each as a
 * share of its height, with the texture cropped to match rather than
 * squashed: the sprite is cut along the line between the two. A share below
 * zero raises the corner without the texture following, so the art stretches.
 * The slope pieces of the block sets cut two square tiles into a slope this
 * way. [CCSprite +476, +480: setTextureCoords :862782-862827, updateTransform
 *  :864326-864367; set in setupCustomSprites :609173-609784, traced by
 *  tools/ref-trace-ida-trims.py]
 */
export type Cut = [number, number];

/**
 * The z layers the game gives an object, back to front. The editor names them
 * B5…T4; the numbers are what a level stores in key 24 and what the object
 * tables carry, and they sort in draw order. Key 24 is never 0 in an official
 * level — 0 and absent both mean "use the object's own default".
 * [meas: key 24 over the 72,046 placements that set it in the 27 official levels]
 */
export const Z_LAYERS = [-5, -3, -1, 1, 3, 5, 7, 9, 11] as const;

export function isZLayer(n: number): boolean {
  return (Z_LAYERS as readonly number[]).includes(n);
}

/** Where a record's halves came from, so gaps stay visible in the report. */
export interface Provenance {
  hb: "gdclone" | "gameTypes" | "manual" | "bootstrap" | "none";
  /** "gameAnimations": the animated sprites are the game's animation table's (tools/assets/objects.ts). */
  art: "gdclone" | "bootstrap" | "gameAnimations" | "manual" | "none";
  /** Where the z layer and order came from; they merge separately from the art. */
  z: "gdclone" | "customSetup" | "bootstrap" | "manual" | "none";
}

export interface ObjectRecord {
  // --- simulation ---------------------------------------------------------
  k: ObjectKind;
  hb: Hitbox;
  passable?: 1;
  breakable?: 1;
  special?: "D" | "J" | "S" | "H" | "F";
  orb?: OrbType;
  pad?: PadType;
  portal?: PortalEffect;
  collectible?: "secretCoin" | "userCoin" | "item" | "key" | "clock";
  forceShape?: "box" | "circle";
  /** Skeletal-monster hazard. */
  anim?: 1;
  /** Sprite footprint in blocks; the collision broadphase falls back to it. */
  gw?: number;
  gh?: number;
  src: "table" | "derived" | "manual";

  // --- art ----------------------------------------------------------------
  f?: string;
  g?: string;
  /** Default z layer and order from the game's own tables. */
  zl?: number;
  zo?: number;
  /** Default base and detail colour channels. */
  bc?: number;
  dc?: number;
  ct?: ColorType;
  /** The object swaps which sprite follows which channel. */
  sw?: 1;
  a?: number;
  bl?: 1;
  /**
   * The game makes the object's own sprite and never draws it (+471): only
   * its children and its glow show. [ChildRecord.dd]
   */
  dd?: 1;
  /** How far its own sprite's top corners are lowered (Cut). */
  cut?: Cut;
  ch?: ChildRecord[];
  // Frame animations are not carried here: the renderer reads the game's own
  // table, assets/gameAnimations.ts.
  /** Picks one frame at random on spawn. */
  rnd?: string[];
  /** Text object: which font, at what size, with what default string. */
  txt?: { font: string; size: number; def: string };
  /** Skeletal entity name, resolvable in anims/index.json. */
  ent?: string;
  /** The particle system customSetup hangs on the object (BuiltInParticle). */
  pt?: BuiltInParticle;
  /** Teleport portal end. */
  tp?: "entry" | "exit";
  p: Provenance;
}

/**
 * A particle system the game hangs on an object as it makes it: the portals'
 * swirl, the orbs' ring, the pads' bump, the speed portals' streaks, the
 * fireballs' trail, the collectibles' sparkle. One effect file each, from
 * particles.json, with what customSetup changes on it.
 * [gdp GameObject::createAndAddParticle :167739-167766, from customSetup,
 *  EnhancedGameObject::customSetup and commonInteractiveSetup; claimParticle
 *  :167570ff; traced by tools/ref-trace-ida-particles.py into
 *  data/ref/customSetup_particles_2206.json]
 */
export interface BuiltInParticle {
  /** The effect's name in particles.json. */
  e: string;
  /** cocos's position type: 1 the particles stay where they were let go, 2 they move with the object. */
  pos: 1 | 2;
  /**
   * The z it is added to the object layer at, whatever the object's layer:
   * 4 for portals and rings, 0 for pads, bubbles and keys, -2 for fireballs
   * and boosts. Absent, 0. [GameObject::createAndAddParticle's 4th argument
   *  → GJBaseGameLayer::createParticle :458906-458908 (the system's tag) →
   *  claimParticle :431656-431700]
   */
  z?: number;
  /** The start and end rgba setStartColor and setEndColor gave it, 0-1; a null alpha keeps the effect's own. */
  s?: [number, number, number, number | null];
  en?: [number, number, number, number | null];
  /** Where it sits from the object's centre, in the object's own space (+672). */
  o?: [number, number];
  /** +669: it takes the object's colour as it comes on screen; +670 the colour sprite's rather than the main one's. */
  c?: 1;
  cs?: 1;
  /** +680: it keeps a scale of 1 rather than the object's. */
  s1?: 1;
  /** +920: it keeps a turn of 0 rather than the object's. */
  r0?: 1;
}

export interface ObjectsFile {
  version: 1;
  /** The atlas resolution every frame name was checked against. */
  validatedAgainst: string;
  /** Decimal id → record. */
  objects: Record<string, ObjectRecord>;
  /** Ids the 27 official levels use, ascending. */
  census: number[];
}
