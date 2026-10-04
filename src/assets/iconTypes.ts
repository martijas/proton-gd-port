// The shape of assets/icons/icons.json.
//
// The game ships every icon as its own little atlas, 1207 of them. The build
// repacks them into a few pages per kind so a level does not open 2400 files,
// and keeps each layer's own trim offset, which is what makes the layers line
// up: the game stacks them at one origin and lets the offsets do the work.

import type { AtlasFrame } from "./atlasTypes";

export type IconKind = "cube" | "ship" | "ball" | "ufo" | "wave" | "robot" | "spider" | "swing" | "jetpack";

/**
 * What a layer is for. `base` is the shape, `secondary` follows the second
 * colour, `dome` is the UFO's canopy, `extra` is the fixed-colour detail (eyes,
 * teeth) and `glow` is the outline drawn behind everything when glow is on.
 */
export type IconLayerRole = "base" | "secondary" | "dome" | "extra" | "glow";

export interface IconLayer {
  role: IconLayerRole;
  /** 1..4 for the robot's and spider's limbs; absent for single-piece icons. */
  part?: number;
  /** Frame name, resolvable in IconFile.frames. */
  n: string;
}

export interface IconDef {
  /** The number in the file name. Cube and ball start at 0, everything else at 1. */
  id: number;
  /** Source base name, e.g. "player_01" — how the animation files refer to it. */
  name: string;
  /** Page holding every one of this icon's layers. */
  page: number;
  layers: IconLayer[];
}

export interface IconPage {
  /** Path relative to assets/. */
  image: string;
  w: number;
  h: number;
  /** Frames on this page; never rotated, so drawing an icon needs no special case. */
  frames: AtlasFrame[];
}

export interface IconFile {
  version: 1;
  res: string;
  pxPerUnit: number;
  pages: IconPage[];
  kinds: Record<IconKind, { prefix: string; count: number; icons: IconDef[] }>;
  /** Frame name → [page index, frame index]. */
  frames: Record<string, [number, number]>;
}

/** Draw order for one icon: glow first, then the shape, then the details on top. */
export const ICON_LAYER_ORDER: readonly IconLayerRole[] = ["glow", "base", "secondary", "dome", "extra"];
