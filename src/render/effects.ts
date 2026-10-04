// The packed page of loose art, as the level renderer sees it.
//
// The player's trail and a few other single PNGs are not sheet frames, and the
// texture unit budget is sixteen with all sixteen already spoken for. They ride
// on the interface's packed page instead, which the asset build fills and which
// one upload serves for both the menus and the level.
//
// The level does not own that upload — the interface does — so what crosses
// over is this: the quads by name, the unit, and the texture to bind.

import type { UiArtFile } from "../assets/miscTypes";
import { assetUrl, fetchAsset } from "../assets/paths";
import { uploadTexture } from "../engine/gl/texture";

/** One piece of packed art, in the same terms a sprite frame gives. */
export interface EffectQuad {
  u0: number;
  v0: number;
  du: number;
  dv: number;
  unit: number;
  /** Size in units. */
  w: number;
  h: number;
}

export interface EffectArt {
  unit: number;
  quad(name: string): EffectQuad | null;
}

/** Frame names the level asks this page for. */
export const EFFECT_FRAMES = {
  /** The default player trail. The icon kit picks among streak_01 to _07. */
  trail: "streak_01_001",
  /** A flat white square, for anything that is a colour rather than a picture. */
  white: "square",
} as const;

/** Wraps a packed page so a caller can ask for a piece by name. */
export function effectArtFrom(file: UiArtFile, unit: number): EffectArt {
  const cache = new Map<string, EffectQuad | null>();
  return {
    unit,
    quad(name: string): EffectQuad | null {
      const cached = cache.get(name);
      if (cached !== undefined) return cached;
      const packed = file.images[name];
      const built: EffectQuad | null = packed
        ? {
            u0: packed.x / file.pageWidth,
            v0: packed.y / file.pageHeight,
            du: packed.w / file.pageWidth,
            dv: packed.h / file.pageHeight,
            unit,
            w: packed.w / packed.pxPerUnit,
            h: packed.h / packed.pxPerUnit,
          }
        : null;
      cache.set(name, built);
      return built;
    },
  };
}

/**
 * Loads the page for a scene with no interface to share one with — the physics
 * debug page. The game does not use this: its menus have already uploaded the
 * page, and a second copy would cost a unit the budget does not have.
 */
export async function loadEffectArt(
  gl: WebGL2RenderingContext,
  unit: number,
): Promise<{ art: EffectArt; texture: WebGLTexture } | null> {
  const file = await fetchAsset<UiArtFile>("ui.json");
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${file.page} could not be loaded`));
    img.src = assetUrl(file.page);
  });
  return { art: effectArtFrom(file, unit), texture: uploadTexture(gl, image) };
}
