// Turning interface pieces into sprite instances.
//
// The counterpart to SceneryRenderer: it owns a Float32Array, writes the same
// 48-byte layout the batcher reads, and touches no GL at all. Keeping it free
// of the context is what lets the whole interface go out as one extra draw call
// on the batch the level is already using.
//
// Everything is in design units with the origin at the bottom-left, y up —
// the same handedness as the world, so the existing vertex shader works with no
// changes and a HUD element can sit over the level without a second program.

import { BLEND, FLAG_GREY, FLAG_TURNED, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import type { Glyph } from "./text";
import type { Rect } from "./viewport";

/** A region of a texture, in 0..1 texture coordinates. */
export interface UiQuad {
  u0: number;
  v0: number;
  du: number;
  dv: number;
  /** Which texture unit it lives on. */
  unit: number;
  /** Natural size in design units, for drawing it at 1:1. */
  w: number;
  h: number;
  /**
   * Where the trimmed region sits inside the frame's untrimmed box, in units.
   * The packer cuts the transparent border off every sheet frame, so a sprite
   * whose art is not centred in its own box — most of the round buttons — lands
   * off-centre without this.
   */
  offsetX?: number;
  offsetY?: number;
  /** cocos packs some frames turned 90°; the shader swaps the corners back. */
  rotated?: boolean;
}

export interface Tint {
  r: number;
  g: number;
  b: number;
  a?: number;
  /**
   * Drawn as the game draws its additive sprites, GL_SRC_ALPHA / GL_ONE on
   * premultiplied art whose colour is already times its opacity: the art's
   * alpha and the opacity count twice (BLEND.ADD_SPRITE). The menu's floor
   * line is the ground layer's, set so when it is made.
   * [GJGroundLayer::createLine :382015-382055 (setBlendFunc(770, 1));
   *  CCSprite::updateColor :863976-864005]
   */
  additive?: boolean;
  /** The art drawn in grey before the tint, as a CCSpriteGrayscale. */
  grey?: boolean;
}

export const WHITE: Tint = { r: 255, g: 255, b: 255 };

export interface SpriteOptions {
  /** Multiplies the quad's natural size. */
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  /** Degrees, clockwise, about the sprite's own centre. */
  rotation?: number;
  tint?: Tint;
  /** 0..1, multiplied into the tint's own alpha. */
  alpha?: number;
  /** Where on the sprite `x`/`y` refer to. Default is its centre. */
  originX?: number;
  originY?: number;
}

/** The four corner insets of a nine-slice frame, in design units. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export class UiBatch {
  private data = new Float32Array(512 * INSTANCE_FLOATS);
  private bytes = new Uint8Array(this.data.buffer);
  private n = 0;

  begin(): void {
    this.n = 0;
  }

  get count(): number {
    return this.n;
  }

  /** The instance buffer, valid up to `count`. */
  get buffer(): Float32Array {
    return this.data;
  }

  /**
   * One sprite. `x`/`y` are its centre unless an origin is given, where 0 is
   * the left/bottom edge and 1 the right/top.
   */
  sprite(quad: UiQuad, x: number, y: number, opts: SpriteOptions = {}): void {
    const sx = (opts.scaleX ?? opts.scale ?? 1) * quad.w * 0.5;
    const sy = (opts.scaleY ?? opts.scale ?? 1) * quad.h * 0.5;
    const ox = opts.originX ?? 0.5;
    const oy = opts.originY ?? 0.5;
    // Move the centre to wherever the caller's origin says it should be, then
    // by the frame's own trim so the art sits where its untrimmed box would.
    // The origin is measured on the sprite as drawn, so a mirrored one is
    // still placed by its own left or right edge.
    const both = opts.scale ?? 1;
    const cx = x + (0.5 - ox) * Math.abs(sx) * 2 + (quad.offsetX ?? 0) * (opts.scaleX ?? both);
    const cy = y + (0.5 - oy) * Math.abs(sy) * 2 + (quad.offsetY ?? 0) * (opts.scaleY ?? both);
    this.raw(quad, cx, cy, sx, sy, opts.rotation ?? 0, opts.tint ?? WHITE, opts.alpha ?? 1);
  }

  /** A sprite stretched to fill a rectangle exactly. */
  stretched(quad: UiQuad, r: Rect, tint: Tint = WHITE, alpha = 1): void {
    this.raw(quad, r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, tint, alpha);
  }

  /**
   * A window frame grown to any size: the four corners stay their own size, the
   * four edges stretch along one axis and the middle stretches along both. Nine
   * sprites, which is why the frames are worth packing onto one page.
   */
  nineSlice(quad: UiQuad, r: Rect, insets: Insets, tint: Tint = WHITE, alpha = 1): void {
    if (r.w <= 0 || r.h <= 0) return;
    // A box narrower than its own two corners has to shrink them, not fold:
    // left over and the corners overlap backwards, which draws a little knot of
    // border where a zero-width bar should show nothing at all.
    const shrinkX = Math.min(1, r.w / Math.max(1e-6, insets.left + insets.right));
    const shrinkY = Math.min(1, r.h / Math.max(1e-6, insets.top + insets.bottom));
    const left = insets.left * shrinkX;
    const right = insets.right * shrinkX;
    const top = insets.top * shrinkY;
    const bottom = insets.bottom * shrinkY;
    // Texture fractions for the three columns and three rows.
    const fx = [0, left / quad.w, 1 - right / quad.w, 1];
    const fy = [0, bottom / quad.h, 1 - top / quad.h, 1];
    // Screen positions for the same, measured from the rectangle's corners.
    const px = [r.x, r.x + left, r.x + r.w - right, r.x + r.w];
    const py = [r.y, r.y + bottom, r.y + r.h - top, r.y + r.h];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const w = px[col + 1] - px[col];
        const h = py[row + 1] - py[row];
        if (w <= 0 || h <= 0) continue;
        const piece = this.subQuad(quad, fx[col], fy[row], fx[col + 1], fy[row + 1]);
        this.raw(piece, px[col] + w / 2, py[row] + h / 2, w / 2, h / 2, 0, tint, alpha);
      }
    }
  }

  /** A flat rectangle, drawn with a one-pixel white sprite. */
  fill(white: UiQuad, r: Rect, tint: Tint, alpha = 1): void {
    this.stretched(white, r, tint, alpha);
  }

  /**
   * A laid-out string. `x`/`y` place the layout's bottom-left corner; the
   * caller has already decided where that is from `measure`.
   */
  text(glyphs: readonly Glyph[], quadFor: (code: number) => UiQuad | null, x: number, y: number, tint: Tint = WHITE, alpha = 1): void {
    for (const g of glyphs) {
      const quad = quadFor(g.code);
      if (!quad) continue;
      this.raw(quad, x + g.x + g.w / 2, y + g.y + g.h / 2, g.w / 2, g.h / 2, 0, tint, alpha);
    }
  }

  /**
   * A sub-rectangle of a quad, in fractions of it. Handles a packed frame that
   * was turned 90°, where the two axes are swapped in the texture.
   */
  subQuad(q: UiQuad, x0: number, y0: number, x1: number, y1: number): UiQuad {
    if (q.rotated) {
      // The frame is stored turned clockwise: its x runs down the texture's v.
      return {
        u0: q.u0 + y0 * q.du,
        v0: q.v0 + x0 * q.dv,
        du: (y1 - y0) * q.du,
        dv: (x1 - x0) * q.dv,
        unit: q.unit,
        w: (x1 - x0) * q.w,
        h: (y1 - y0) * q.h,
        rotated: true,
      };
    }
    return {
      u0: q.u0 + x0 * q.du,
      // Texture v runs down while design y runs up, so the top of the piece is
      // the bottom of its texture range.
      v0: q.v0 + (1 - y1) * q.dv,
      du: (x1 - x0) * q.du,
      dv: (y1 - y0) * q.dv,
      unit: q.unit,
      w: (x1 - x0) * q.w,
      h: (y1 - y0) * q.h,
    };
  }

  private raw(q: UiQuad, cx: number, cy: number, hw: number, hh: number, degrees: number, tint: Tint, alpha: number): void {
    this.ensure(this.n + 1);
    const f = this.n * INSTANCE_FLOATS;
    const s = this.data;
    if (degrees === 0) {
      s[f] = hw;
      s[f + 1] = 0;
      s[f + 2] = 0;
      s[f + 3] = hh;
    } else {
      const rad = (degrees * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      s[f] = hw * cos;
      s[f + 1] = hw * sin;
      s[f + 2] = -hh * sin;
      s[f + 3] = hh * cos;
    }
    s[f + 4] = cx;
    s[f + 5] = cy;
    s[f + 6] = q.u0;
    s[f + 7] = q.v0;
    s[f + 8] = q.du;
    s[f + 9] = q.dv;

    const o = this.n * INSTANCE_BYTES;
    const b = this.bytes;
    const a = Math.max(0, Math.min(1, (tint.a ?? 1) * alpha));
    // The colour goes in as it is and the opacity beside it: the shader
    // multiplies the one by the other, as cocos does to a sprite's colour on
    // premultiplied art. Multiplying it in here as well counted the opacity
    // twice, so every fade went dark before it went clear.
    b[o + 40] = Math.round(tint.r);
    b[o + 41] = Math.round(tint.g);
    b[o + 42] = Math.round(tint.b);
    // The alpha is written as it is for an additive sprite too: the shader
    // multiplies the colour by it and zeroes the *output* alpha from the flag
    // below, which is what turns the batch's usual blend into addition.
    // Writing zero here instead multiplied the colour away and added nothing —
    // the menu's ground line was drawn and invisible.
    b[o + 43] = Math.round(a * 255);
    b[o + 44] = q.unit;
    b[o + 45] = (q.rotated ? FLAG_TURNED : 0) | (tint.grey ? FLAG_GREY : 0);
    b[o + 46] = tint.additive ? BLEND.ADD_SPRITE : BLEND.NORMAL;
    b[o + 47] = 0;
    this.n++;
  }

  private ensure(needed: number): void {
    if (needed * INSTANCE_FLOATS <= this.data.length) return;
    const grown = new Float32Array(Math.max(needed * 2, 512) * INSTANCE_FLOATS);
    grown.set(this.data);
    this.data = grown;
    this.bytes = new Uint8Array(this.data.buffer);
  }
}
