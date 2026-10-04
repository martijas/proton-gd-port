// The shape of assets/atlas/<res>.json, shared by the generator, the runtime
// and the debug pages.
//
// Coordinates here are texture pixels with y pointing down, which is what a
// sampler wants; everything else in the port is GD units with y up. `pxPerUnit`
// is the bridge: uhd art is 4 px per unit, hd 2, sd 1.

/**
 * One packed sprite.
 *
 * `w`/`h` are the size of the region in its upright orientation. When `r` is
 * set the region is stored turned 90° clockwise, so in the atlas it covers `h`
 * px across and `w` px down starting at (`x`, `y`); a frame-local edge
 * coordinate (fx, fy) then maps to (x + h - fy, y + fx). This is the same
 * convention cocos2d-x uses for a rotated sprite frame. Those are edges, not
 * texel centres: a texel loop reads (x + h - 1 - fy, y + fx).
 *
 * `tx`/`ty` place the region inside the untrimmed source box `sw` × `sh`, again
 * y down. Drawing a frame means centring an `sw` × `sh` box on the object and
 * putting the region at (`tx`, `ty`) inside it. Both pairs are omitted when
 * they carry no information: no `tx`/`ty` means (0, 0), no `sw`/`sh` means the
 * source box is exactly `w` × `h`.
 *
 * All four of those are stated in the sprite's UPRIGHT frame and never change
 * with `r` — the generator computes them from the unrotated `textureRect`. So
 * they cannot be mixed with `x`/`y`, which are atlas coordinates. In sheet
 * space use `frameSourceRect`, which does the turn for you.
 */
export interface AtlasFrame {
  n: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r?: 1;
  tx?: number;
  ty?: number;
  sw?: number;
  sh?: number;
}

export interface Atlas {
  /** Sheet name with no resolution suffix, e.g. "GJ_GameSheet". */
  name: string;
  /** Path relative to assets/, e.g. "atlas/uhd/GJ_GameSheet.png". */
  image: string;
  /** Size of the png in px. */
  w: number;
  h: number;
  frames: AtlasFrame[];
}

export interface AtlasFile {
  version: 1;
  res: "sd" | "hd" | "uhd";
  pxPerUnit: number;
  atlases: Atlas[];
  /**
   * Frame name → [atlas index, frame index]. Frame names are unique across
   * every sheet the game ships, so one flat index is enough.
   */
  frames: Record<string, [number, number]>;
}

/** Where a frame lives once an atlas file is loaded. */
export interface FrameLocation {
  atlas: Atlas;
  frame: AtlasFrame;
  atlasIndex: number;
}

/** The untrimmed source box of a frame, in px, upright — never swapped for `r`. */
export function frameSourceSize(f: AtlasFrame): { w: number; h: number } {
  return { w: f.sw ?? f.w, h: f.sh ?? f.h };
}

/** Where the region sits inside that source box, in px, y down, upright. */
export function frameTrimOffset(f: AtlasFrame): { x: number; y: number } {
  return { x: f.tx ?? 0, y: f.ty ?? 0 };
}

/** The rectangle the region occupies in the atlas, accounting for rotation. */
export function framePackedRect(f: AtlasFrame): { x: number; y: number; w: number; h: number } {
  return f.r ? { x: f.x, y: f.y, w: f.h, h: f.w } : { x: f.x, y: f.y, w: f.w, h: f.h };
}

/**
 * The untrimmed source box in ATLAS space: where the whole sprite would sit on
 * the sheet if none of it had been trimmed away. It always contains
 * `framePackedRect`.
 *
 * This is the one to use in sheet coordinates. Subtracting the trim offset from
 * the packed position by hand only works for an upright frame; a rotated source
 * box is turned with its region, so it runs `sh` across and `sw` down, and the
 * margin that was above the sprite ends up on its right.
 */
export function frameSourceRect(f: AtlasFrame): { x: number; y: number; w: number; h: number } {
  const src = frameSourceSize(f);
  const off = frameTrimOffset(f);
  return f.r
    ? { x: f.x + f.h + off.y - src.h, y: f.y - off.x, w: src.h, h: src.w }
    : { x: f.x - off.x, y: f.y - off.y, w: src.w, h: src.h };
}
