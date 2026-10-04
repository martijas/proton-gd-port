// Where an atlas frame lands in object space, and which part of the sheet it
// samples. Pure: no GL, no canvas, so the batcher and the 2D debug view can be
// held to the same answer.
//
// This is the one piece of geometry that has to match src/debug/objectTab.ts
// exactly, because that view is what proved the atlas conversion in goal 2.
// Working it through: for both the upright and the rotated case the destination
// quad is identical — a rotated frame is stored turned, not drawn turned — and
// only the texture coordinates differ. That is the whole of the rotation case.

import { frameSourceSize, frameTrimOffset, type Atlas, type AtlasFrame } from "../assets/atlasTypes";

export interface FrameQuad {
  /** Centre of the sprite in object space, relative to the object's origin, in units. */
  cx: number;
  cy: number;
  /** Half width and height in units. */
  hw: number;
  hh: number;
  /** Texture rect, normalised. `du` is negative for a rotated frame. */
  u0: number;
  v0: number;
  du: number;
  dv: number;
  /** The quad's corner components are swapped before sampling. */
  rotated: boolean;
}

/**
 * `pxPerUnit` is the resolution the sheet was measured at: 4 for uhd, 2 for hd,
 * 1 for the sd-only trail and ship-fire art. Get it wrong and the sprite is off
 * by a factor of two.
 */
export function frameQuad(atlas: Atlas, frame: AtlasFrame, pxPerUnit: number): FrameQuad {
  const src = frameSourceSize(frame);
  const off = frameTrimOffset(frame);
  // Texture space has y down and the sprite is centred on its untrimmed box, so
  // the trim offset moves the region inside that box from the top left.
  const cx = (off.x + frame.w / 2 - src.w / 2) / pxPerUnit;
  const cy = -(off.y + frame.h / 2 - src.h / 2) / pxPerUnit;
  const hw = frame.w / (2 * pxPerUnit);
  const hh = frame.h / (2 * pxPerUnit);

  if (frame.r) {
    // Stored turned 90° clockwise: the region runs `h` across and `w` down, and
    // a frame-local (fx, fy) reads (x + h - fy, y + fx).
    return {
      cx,
      cy,
      hw,
      hh,
      u0: (frame.x + frame.h) / atlas.w,
      v0: frame.y / atlas.h,
      du: -frame.h / atlas.w,
      dv: frame.w / atlas.h,
      rotated: true,
    };
  }
  return {
    cx,
    cy,
    hw,
    hh,
    u0: frame.x / atlas.w,
    v0: frame.y / atlas.h,
    du: frame.w / atlas.w,
    dv: frame.h / atlas.h,
    rotated: false,
  };
}

/**
 * The texture coordinate a quad corner samples. `qx`/`qy` run 0..1 across the
 * quad, left to right and top to bottom. The shader does this inline; this is
 * here so a test can check the two agree.
 */
export function quadUv(q: FrameQuad, qx: number, qy: number): { u: number; v: number } {
  const x = q.rotated ? qy : qx;
  const y = q.rotated ? qx : qy;
  return { u: q.u0 + x * q.du, v: q.v0 + y * q.dv };
}
