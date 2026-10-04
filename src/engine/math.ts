// Small maths for the renderer: interpolation and 2D affines.
//
// Units are GD units with y up, the same as the simulation. Angles are degrees
// turning clockwise, which is how the game stores rotation and how cocos reads
// it — so a positive angle turns a sprite to the right on screen.

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Degrees, wrapped to (-180, 180]. */
export function wrapDegrees(deg: number): number {
  const d = ((deg + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Interpolates the short way round, so 350° to 10° crosses zero instead of unwinding. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapDegrees(b - a) * t;
}

/**
 * A 2D affine transform, column-major like cocos:
 *
 *   x' = a·x + c·y + tx
 *   y' = b·x + d·y + ty
 *
 * The renderer bakes an object's rotation, scale and flip into `a`..`d` and its
 * world position into `tx`/`ty`, so a sprite is one matrix and a unit quad.
 */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/**
 * Scale, then rotate, then translate — the order the game's own transforms
 * apply. `deg` turns clockwise, which in a y-up space is a negative angle.
 */
export function affine(x: number, y: number, deg: number, sx: number, sy: number): Affine {
  const r = (-deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, tx: x, ty: y };
}

/**
 * `affine` with the two axes turned apart, as cocos's rotation X and Y do it:
 * the sprite's x axis turns by `degY` and its y axis by `degX`, each
 * clockwise. Equal angles are an ordinary turn; unequal ones skew. An object
 * gets them from keys 131 and 132 (see physics/objects.ts loadAngles).
 * [cocos2d::CCNode::nodeToParentTransform, gd-ida-decomp.cpp:788575-788617]
 */
export function affineXY(x: number, y: number, degX: number, degY: number, sx: number, sy: number): Affine {
  const rx = (-degX * Math.PI) / 180;
  const ry = (-degY * Math.PI) / 180;
  return { a: Math.cos(ry) * sx, b: Math.sin(ry) * sx, c: -Math.sin(rx) * sy, d: Math.cos(rx) * sy, tx: x, ty: y };
}

/** `outer` applied to `inner`: the child's transform seen from the parent's frame. */
export function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

export function apply(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty };
}

/**
 * Half-extents of the axis-aligned box that contains a `hw` × `hh` quad once
 * `m` has turned and scaled it. Used for culling, so it has to be generous
 * rather than exact — and for an unrotated sprite it is exact anyway.
 */
export function extent(m: Affine, hw: number, hh: number): { hx: number; hy: number } {
  return {
    hx: Math.abs(m.a) * hw + Math.abs(m.c) * hh,
    hy: Math.abs(m.b) * hw + Math.abs(m.d) * hh,
  };
}
