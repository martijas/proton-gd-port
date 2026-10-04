// Text objects (id 914): a string a level draws in the game's own face.
//
// The string lives in the object's property 31, url-safe base64 of the plain
// text — "SG9sZA==" is Fingerdash's "Hold". Everything else about the object is
// ordinary: it takes the position, rotation, scale and colour channel every
// other object takes, so once the glyphs are quads they go through the same
// bake and the same per-frame colour path as a block does.
//
// Layout is the interface's, not a second copy of it. `ui/text.ts` already
// measures and wraps this font for the menus, and a level's text has to break
// the same way or the two disagree about what the face is.

import { base64ToBytes } from "../level/decode";
import type { LevelObject } from "../level/types";
import type { Font, FontFile } from "../assets/miscTypes";
import { assetUrl, fetchAsset } from "../assets/paths";
import { uploadTexture } from "../engine/gl/texture";
import { layout } from "../ui/text";

/** Property 31 on a text object: the string, url-safe base64. */
const TEXT_PROP = "31";

const decoder = new TextDecoder();

/**
 * The string a text object draws, or null when it has none.
 *
 * A level can carry anything here, so a value that does not decode is treated
 * as absent rather than drawn as mojibake — the object then simply shows
 * nothing, which is what an empty text object does anyway.
 */
export function textOf(object: LevelObject): string | null {
  const raw = object.props[TEXT_PROP];
  if (!raw) return null;
  try {
    const text = decoder.decode(base64ToBytes(raw)).replace(/\0+$/, "");
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** One glyph, ready to go through an object's transform. */
export interface TextSprite {
  u0: number;
  v0: number;
  du: number;
  dv: number;
  /** Half-extents in level units, before the object's own scale. */
  hw: number;
  hh: number;
  /** Centre, in level units relative to the object's position. */
  cx: number;
  cy: number;
}

/**
 * The glyphs of `text`, centred on the object's own position.
 *
 * The face is drawn at its design size — a capital comes out a little under a
 * block tall — and the object's scale takes it from there, which is how the
 * levels use it: Deadlocked spells its message one object per letter at scale
 * 1, and The Secret Hollow's readouts sit at 0.46.
 */
export function textSprites(text: string, font: Font, pxPerUnit: number): TextSprite[] {
  const placed = layout(font, pxPerUnit, text, { align: "center" });
  const out: TextSprite[] = [];
  // `layout` puts the block's bottom-left at the origin; an object's position
  // is its centre.
  const ox = placed.width / 2;
  const oy = placed.height / 2;
  for (const glyph of placed.glyphs) {
    if (glyph.w <= 0 || glyph.h <= 0) continue;
    out.push({
      u0: glyph.char.x / font.scaleW,
      v0: glyph.char.y / font.scaleH,
      du: glyph.char.w / font.scaleW,
      dv: glyph.char.h / font.scaleH,
      hw: glyph.w / 2,
      hh: glyph.h / 2,
      cx: glyph.x + glyph.w / 2 - ox,
      cy: glyph.y + glyph.h / 2 - oy,
    });
  }
  return out;
}

/** What the draw list needs in order to bake a level's text. */
export interface LevelFont {
  font: Font;
  pxPerUnit: number;
  /** Texture unit the font page is bound to when the level draws. */
  unit: number;
}

/**
 * Loads one face for a scene that has no interface to share one with — the
 * physics debug page, which is where the renderer is verified.
 *
 * The game does not use this: its menus have already uploaded the face, and
 * a second copy of the same page would cost a texture unit out of a budget
 * that is exactly full.
 */
export async function loadLevelFont(
  gl: WebGL2RenderingContext,
  name: string,
  unit: number,
): Promise<{ levelFont: LevelFont; texture: WebGLTexture } | null> {
  const file = await fetchAsset<FontFile>("fonts/fonts.json");
  const font = file.fonts[name];
  if (!font) return null;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${font.image} could not be loaded`));
    img.src = assetUrl(font.image);
  });
  const texture = uploadTexture(gl, image);
  return { levelFont: { font, pxPerUnit: file.pxPerUnit, unit }, texture };
}
