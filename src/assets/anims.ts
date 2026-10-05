// Loading side of assets/anims/: the skeletal animations.
//
// The robot, the spider and the level's beasts are not sprite sequences — they
// are a handful of limb textures moved about by a per-frame transform, which is
// what the game's AnimDesc files describe. A frame is a list of parts, each
// naming the texture it uses, where it sits relative to the body, how it is
// turned and scaled, and how deep it is in the stack.
//
// The part textures in the file are always icon 01's (`robot_01_03_001.png`),
// because that is the icon the animation was authored against. Drawing somebody
// else's robot means keeping the transform and swapping the texture for the
// same part number of their own icon, which is what `partOf` is for.

import { fetchAsset } from "./paths";

/** One limb in one frame of an animation. */
export interface AnimPart {
  /** Texture as the animation names it, always icon 01's. */
  tex: string;
  /** Which of the object's own parts this is; the same tex can appear twice. */
  tag: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  /** Degrees, clockwise like everything else. */
  rot: number;
  /** Draw order inside the frame, low first. */
  z: number;
  /** Set on the parts drawn behind the body. */
  id?: string;
}

export interface AnimClip {
  /** Seconds per frame. Zero for a pose. */
  delay: number;
  frames: number;
  looped: number;
  prio: number;
  usesParts: number;
  /** A one-frame clip names its frame outright. */
  singleFrame?: string;
}

export interface AnimEntity {
  name: string;
  textures: AnimPart[];
  /** Frame name (`Robot_run_003.png`) to the parts that make it up. */
  frames: Record<string, AnimPart[]>;
  animations: Record<string, AnimClip>;
  /** The clip the sprite starts on. */
  defaultAnimation?: string;
}

export interface AnimIndex {
  version: 1;
  entities: Record<string, { file: string; animations: string[]; frames: number }>;
}

export class AnimSet {
  private readonly loaded = new Map<string, Promise<AnimEntity>>();

  private constructor(readonly index: AnimIndex) {}

  static async load(): Promise<AnimSet> {
    return new AnimSet(await fetchAsset<AnimIndex>("anims/index.json"));
  }

  has(name: string): boolean {
    return this.index.entities[name] !== undefined;
  }

  names(): string[] {
    return Object.keys(this.index.entities);
  }

  entity(name: string): Promise<AnimEntity> | undefined {
    const entry = this.index.entities[name];
    if (!entry) return undefined;
    let pending = this.loaded.get(name);
    if (!pending) {
      pending = fetchAsset<AnimEntity>(entry.file);
      this.loaded.set(name, pending);
    }
    return pending;
  }
}

/**
 * The parts of one frame of a clip, or undefined when the clip has no such
 * frame. `frame` counts from zero and is taken modulo the clip's length for a
 * looping clip, or clamped to the last frame for one that plays once.
 */
export function animFrame(entity: AnimEntity, clip: string, frame: number): AnimPart[] | undefined {
  const anim = entity.animations[clip];
  if (!anim) return undefined;
  if (anim.singleFrame) return entity.frames[anim.singleFrame];
  const count = Math.max(1, anim.frames);
  const at = anim.looped ? ((frame % count) + count) % count : Math.min(frame, count - 1);
  return entity.frames[`${entity.name}_${clip}_${String(at + 1).padStart(3, "0")}.png`];
}

/**
 * Which numbered part of an icon a texture belongs to. `robot_01_03_001.png`
 * is part 3; the same name with any other icon number is the same part.
 */
export function partOf(tex: string): number {
  const m = /_(\d{2})_(\d{2})_/.exec(tex);
  return m ? Number(m[2]) : 1;
}
