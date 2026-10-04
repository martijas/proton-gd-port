// Atlas pages as textures.
//
// Everything is uploaded premultiplied. The art on disk is straight alpha, and
// at a typical camera zoom the uhd sheets are minified about two and a half
// times — filtering straight alpha across a transparent edge bleeds the
// transparent texel's colour (black) into the sprite and leaves a dark halo on
// every outline in the game. Premultiplying at upload is what avoids it, and it
// is also what lets one blend state serve both normal and additive drawing.
//
// No mipmaps: the sheets are tightly packed, so a lower level would bleed one
// sprite into its neighbour. A sheet can be 4096 px, which every WebGL2
// implementation supports.

import { UPLOAD_UNIT } from "./spriteBatch";

export interface UploadOptions {
  /** Clamp is right for an atlas: a frame must never wrap onto its neighbour. */
  wrap?: number;
  filter?: number;
}

export function uploadTexture(
  gl: WebGL2RenderingContext,
  source: TexImageSource,
  options: UploadOptions = {},
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("could not create a texture");
  const filter = options.filter ?? gl.LINEAR;
  const wrap = options.wrap ?? gl.CLAMP_TO_EDGE;
  // Uploading means binding, and a bind lands on whichever unit is active — so
  // an upload takes over whatever the last caller left active and then, at the
  // end of this function, leaves it empty. Every upload goes through the one
  // scratch unit so it can never reach a unit something is drawing from.
  gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
