// Shapes of the smaller asset files: particles, skeletal animations, fonts,
// scenery and the loose sprites that never made it into a sheet.

// --- particles ---------------------------------------------------------------

/**
 * One Particle-Designer effect, with the plist's own key names kept so the
 * emitter can be read against cocos2d's documentation. Numbers are as written;
 * angles are degrees and durations seconds, which is what the format uses.
 */
export interface ParticleDef {
  [key: string]: number | string | boolean;
}

export interface ParticleFile {
  version: 1;
  /** Keyed by the plist's base name, e.g. "dragEffect", "portalEffect01". */
  effects: Record<string, ParticleDef>;
  /**
   * Textures an effect asks for that the install does not contain anywhere.
   * Two really are missing from the game's own files, so the renderer needs a
   * fallback rather than a fix.
   */
  missingTextures: string[];
}

// --- skeletal animation ------------------------------------------------------

/** One sprite of one animation frame, positioned in the entity's own space. */
export interface AnimSprite {
  /** Frame name, or the icon-relative name for the player's robot and spider. */
  tex: string;
  /** Which limb this sprite belongs to. */
  tag: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  /** Degrees, clockwise positive. */
  rot: number;
  fx?: 1;
  fy?: 1;
  z: number;
}

export interface AnimEntity {
  name: string;
  /** Textures the animation uses, in tag order. */
  textures: { tex: string; tag: number; id?: string }[];
  /** Frame name → the sprites that make it up, in draw order. */
  frames: Record<string, AnimSprite[]>;
  /** Named animations from objectDefinitions.plist. */
  animations: Record<string, { delay: number; frames: number; looped: 0 | 1; prio: number; usesParts: 0 | 1; other?: number; singleFrame?: string }>;
}

export interface AnimIndex {
  version: 1;
  entities: Record<string, { file: string; animations: string[]; frames: number }>;
}

// --- fonts -------------------------------------------------------------------

export interface FontChar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset from the pen position, px, y down. */
  xo: number;
  yo: number;
  /** How far the pen moves after drawing, px. */
  xa: number;
}

export interface Font {
  face: string;
  size: number;
  lineHeight: number;
  base: number;
  /** Page image size in px. */
  scaleW: number;
  scaleH: number;
  /** Path relative to assets/. */
  image: string;
  /** Character code → glyph. */
  chars: Record<number, FontChar>;
  /** "first,second" → how much to move the pen. */
  kernings?: Record<string, number>;
}

export interface FontFile {
  version: 1;
  pxPerUnit: number;
  fonts: Record<string, Font>;
}

// --- scenery and loose sprites ----------------------------------------------

export interface SceneryImage {
  /** Path relative to assets/. */
  image: string;
  w: number;
  h: number;
}

export interface SceneryFile {
  version: 1;
  pxPerUnit: number;
  /** Background id (1..59) → image. */
  backgrounds: Record<number, SceneryImage>;
  /** Ground id (1..22) → the base layer and, for 8 and up, its detail layer. */
  grounds: Record<number, { base: SceneryImage; detail?: SceneryImage }>;
  /** Foreground id (1..3) → the two layers. */
  foregrounds: Record<number, { base: SceneryImage; detail?: SceneryImage }>;
}

/**
 * assets/ui.json: the interface's own art, packed onto one page so the whole
 * menu costs one texture unit. Each entry carries its own `pxPerUnit` because
 * a couple of these only exist at hd or sd in the install.
 */
export interface UiArtFile {
  version: 1;
  page: string;
  pageWidth: number;
  pageHeight: number;
  images: Record<string, SceneryImage & { x: number; y: number; pxPerUnit: number }>;
  /**
   * Faces whose glyph page is on this page rather than on a unit of its own,
   * keyed in `images` by the face name. The face's `.fnt` metrics still come
   * from fonts.json; only where the pixels are differs.
   */
  packedFonts?: string[];
  /**
   * The main menu's backdrop and the ground it hangs from, beside the page
   * because a tile that repeats needs a texture of its own.
   */
  menu?: {
    background: SceneryImage & { pxPerUnit: number };
    ground: SceneryImage & { pxPerUnit: number };
  };
}

export interface LooseFile {
  version: 1;
  /**
   * These only exist at sd in the install, so one pixel is one unit. Drawing
   * them at the sheet scale would make every trail four times too big.
   */
  pxPerUnit: number;
  images: Record<string, SceneryImage>;
}

/**
 * The screen effects' fragment shader as the exe carries it, GLSL ES 1.00.
 * The renderer converts it to 3.00 when it compiles it. [tools/assets/shaders.ts]
 */
export interface ShaderLayerFile {
  version: 1;
  fragment: string;
}
