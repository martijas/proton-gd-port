// Shape primitives for the collision pass. Everything works on plain numbers
// so the hot path never allocates; the callers keep shapes in typed arrays.
//
// Conventions: GD units, +y up. Rectangles are (min x, min y, max x, max y).
// Rotations in the level string are clockwise-positive degrees (cocos), so a
// point rotated "by θ" here means clockwise unless stated.

const DEG = Math.PI / 180;

/**
 * cocos2d CCRect::intersectsRect — touching edges count as intersecting. That
 * is load-bearing: a cube standing exactly on a block "intersects" it every
 * tick, which is how m_isOnGround gets re-established.
 */
export function rectsTouch(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  return !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0);
}

/** Clockwise rotation of a local offset by `deg` — how a child point of a rotated object moves. */
export function rotateCW(x: number, y: number, deg: number): [number, number] {
  if (deg === 0) return [x, y];
  const r = deg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c + y * s, -x * s + y * c];
}

/** Rotation normalised to [0, 360). */
export function normDeg(deg: number): number {
  let r = deg % 360;
  if (r < 0) r += 360;
  return r;
}

/** The game's "pointing down" arc off the right angles: 91..269 either way round. */
const facingDownArc = (r: number): boolean => (r >= 91 && r <= 269) || (r >= -269 && r <= -91);

/**
 * GameObject::isFacingDown: 180 on the right angles, 91..269 off them — on
 * the integer part of the rotation — then turned over by flipY. flipX plays
 * no part. `rotation` is the object's own, unwrapped (ObjectSet.rawRot): the
 * game truncates without wrapping, so −90.5 is a right angle and 540 is not
 * 180.
 * [gdp GameObject::isFacingDown, gd-ida-decomp.cpp:170986-171000; vfunc +708
 *  is the flipY getter, paired with setter +616 at :172750-172755]
 */
export function isFacingDown(rotation: number, flipY: boolean): boolean {
  const r = Math.trunc(rotation);
  const down = r % 90 !== 0 ? facingDownArc(r) : Math.abs(r) === 180;
  return down !== flipY;
}

/**
 * GameObject::isFacingLeft, which rotated gameplay asks instead. On the right
 * angles only 270 faces left and 90 faces right, flipY turning either over;
 * 0 and 180 face neither way whatever flipY says. Off the right angles the
 * game reuses the down test unchanged, and so does this. flipY again, not flipX.
 * The rotation is unwrapped here too; a negative right angle has 360 added
 * once and no more, so −450 faces neither way.
 * [gdp GameObject::isFacingLeft, gd-ida-decomp.cpp:171017-171050]
 */
export function isFacingLeft(rotation: number, flipY: boolean): boolean {
  const r = Math.trunc(rotation);
  if (r % 90 !== 0) return facingDownArc(r) !== flipY;
  const w = r < 0 ? r + 360 : r;
  if (w === 270) return !flipY;
  if (w === 90) return flipY;
  return false;
}

/** Nearest multiple of 90 for solids/slopes, which only honour right-angle steps. */
export function snap90(deg: number): 0 | 90 | 180 | 270 {
  const q = Math.round(normDeg(deg) / 90) % 4;
  return (q * 90) as 0 | 90 | 180 | 270;
}

/**
 * Axis-aligned rect vs oriented box (centre, half extents, clockwise angle).
 * Separating-axis test on the four candidate axes; touching counts as a hit,
 * matching the AABB rule above.
 */
export function rectHitsObb(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  cosR: number,
  sinR: number,
): boolean {
  // OBB corners (clockwise rotation: local (x,y) → (x c + y s, −x s + y c)).
  const ex = hw * cosR;
  const ey = -hw * sinR;
  const fx = hh * sinR;
  const fy = hh * cosR;
  // Project the OBB onto the world axes.
  const px = Math.abs(ex) + Math.abs(fx);
  const py = Math.abs(ey) + Math.abs(fy);
  if (cx + px < ax0 || cx - px > ax1 || cy + py < ay0 || cy - py > ay1) return false;
  // Project the AABB onto the OBB's own axes.
  const acx = (ax0 + ax1) * 0.5;
  const acy = (ay0 + ay1) * 0.5;
  const ahw = (ax1 - ax0) * 0.5;
  const ahh = (ay1 - ay0) * 0.5;
  const dx = acx - cx;
  const dy = acy - cy;
  // axis u = (cos, −sin) (the OBB's local x), v = (sin, cos) (local y)
  const du = dx * cosR - dy * sinR;
  const ru = ahw * Math.abs(cosR) + ahh * Math.abs(sinR);
  if (Math.abs(du) > hw + ru) return false;
  const dv = dx * sinR + dy * cosR;
  const rv = ahw * Math.abs(sinR) + ahh * Math.abs(cosR);
  if (Math.abs(dv) > hh + rv) return false;
  return true;
}

/**
 * OBB2D::overlaps, both ways: two oriented boxes (centre, half extents, and
 * the cosine and sine of a clockwise angle, as rectHitsObb takes them) meet
 * unless one of the four face axes separates them. Touching counts, as it
 * does in overlaps1Way (`min > origin + 1 || max < origin` is a miss).
 * [gdp OBB2D::overlaps1Way, gd-ida-decomp.cpp:49717-49750; overlaps
 *  :49776-49783; the corners and axes, calculateWithCenter :49580-49611 and
 *  computeAxes :49417-49437]
 */
export function obbsTouch(
  acx: number,
  acy: number,
  ahw: number,
  ahh: number,
  acos: number,
  asin: number,
  bcx: number,
  bcy: number,
  bhw: number,
  bhh: number,
  bcos: number,
  bsin: number,
): boolean {
  const dx = bcx - acx;
  const dy = bcy - acy;
  // Each box's axes: u = (cos, −sin), its local x; v = (sin, cos), its local y.
  const c = Math.abs(acos * bcos + asin * bsin);
  const s = Math.abs(acos * bsin - asin * bcos);
  if (Math.abs(dx * acos - dy * asin) > ahw + bhw * c + bhh * s) return false;
  if (Math.abs(dx * asin + dy * acos) > ahh + bhw * s + bhh * c) return false;
  if (Math.abs(dx * bcos - dy * bsin) > bhw + ahw * c + ahh * s) return false;
  if (Math.abs(dx * bsin + dy * bcos) > bhh + ahw * s + ahh * c) return false;
  return true;
}

/**
 * GJBaseGameLayer::rectIntersectsCircle: the exact test — the rect's nearest
 * point strictly inside the circle. The game keeps it for the spider's hazard
 * search; the collision pass itself uses rectCornersHitCircle.
 * [gd-ida-decomp.cpp:419774-419824; used by damagingObjectsInRect :420031-420039]
 */
export function rectHitsCircle(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const qx = cx < ax0 ? ax0 : cx > ax1 ? ax1 : cx;
  const qy = cy < ay0 ? ay0 : cy > ay1 ? ay1 : cy;
  const dx = cx - qx;
  const dy = cy - qy;
  return dx * dx + dy * dy < r * r;
}

/**
 * GJBaseGameLayer::objectIntersectsCircle, which is how the collision pass
 * meets a saw or any other round object in a level without kA39: a hit only
 * if the circle's centre is in the rect, edges included, or a corner of the
 * rect is strictly inside the circle. A circle that crosses one side of the
 * rect between two corners, centre outside, does not count — so a player can
 * graze a saw's rim with a flat face.
 * [gdp GJBaseGameLayer::objectIntersectsCircle, gd-ida-decomp.cpp:419666-419706;
 *  chosen by playerCircleCollision :419752-419758]
 */
export function rectCornersHitCircle(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  if (cx >= ax0 && cx <= ax1 && cy >= ay0 && cy <= ay1) return true;
  const r2 = r * r;
  const dx0 = ax0 - cx;
  const dx1 = ax1 - cx;
  const dy0 = ay0 - cy;
  const dy1 = ay1 - cy;
  return dx1 * dx1 + dy1 * dy1 < r2 || dx1 * dx1 + dy0 * dy0 < r2 || dx0 * dx0 + dy0 * dy0 < r2 || dx0 * dx0 + dy1 * dy1 < r2;
}

export function circleHitsCircle(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/** Axis-aligned rect vs triangle (a, b, c), separating-axis test on 2 + 3 axes. */
export function rectHitsTriangle(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  tax: number,
  tay: number,
  tbx: number,
  tby: number,
  tcx: number,
  tcy: number,
): boolean {
  const tminx = Math.min(tax, tbx, tcx);
  const tmaxx = Math.max(tax, tbx, tcx);
  const tminy = Math.min(tay, tby, tcy);
  const tmaxy = Math.max(tay, tby, tcy);
  if (tmaxx < ax0 || tminx > ax1 || tmaxy < ay0 || tminy > ay1) return false;
  // Edge normals of the triangle.
  const xs = [tax, tbx, tcx];
  const ys = [tay, tby, tcy];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const nx = -(ys[j] - ys[i]);
    const ny = xs[j] - xs[i];
    // Triangle projection.
    let tmin = Infinity;
    let tmax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const p = xs[k] * nx + ys[k] * ny;
      if (p < tmin) tmin = p;
      if (p > tmax) tmax = p;
    }
    // Rect projection.
    let rmin = Infinity;
    let rmax = -Infinity;
    for (let k = 0; k < 4; k++) {
      const px = k & 1 ? ax1 : ax0;
      const py = k & 2 ? ay1 : ay0;
      const p = px * nx + py * ny;
      if (p < rmin) rmin = p;
      if (p > rmax) rmax = p;
    }
    if (tmax < rmin || rmax < tmin) return false;
  }
  return true;
}

/**
 * Slope orientation. The base triangle (no flips, rotation 0) has its right
 * angle bottom-right and the hypotenuse rising left → right with the solid
 * part below it. Flips apply before the (90°-snapped) rotation, so the
 * right-angle corner ends up in one of four quadrants, which is all the game
 * needs: `uphill` (m_slopeUphill, surface rises to the right) and
 * `solidAbove` (slopeFloorTop, the solid part is on top → a ceiling slope).
 * See research_level-format.md §5.2 for the eight-type table this reproduces.
 */
export function slopeOrientation(
  flipX: boolean,
  flipY: boolean,
  rotation: number,
): { uphill: boolean; solidAbove: boolean; swapped: boolean } {
  let cx = 1;
  let cy = -1;
  if (flipX) cx = -cx;
  if (flipY) cy = -cy;
  const rot = snap90(rotation);
  const [rx, ry] = rotateCW(cx, cy, rot);
  return { uphill: Math.sign(rx) !== Math.sign(ry), solidAbove: ry > 0, swapped: rot === 90 || rot === 270 };
}

/**
 * Slerp2D from the decomp (angles in radians): interpolates two half-angle
 * unit quaternions and returns the doubled result, so the shortest arc wins.
 */
export function slerp2D(startAngle: number, endAngle: number, t: number): number {
  const halfStart = startAngle * 0.5;
  const halfEnd = endAngle * 0.5;
  const cosStart = Math.cos(halfStart);
  const sinStart = Math.sin(halfStart);
  let cosEnd = Math.cos(halfEnd);
  let sinEnd = Math.sin(halfEnd);
  let dot = cosStart * cosEnd + sinStart * sinEnd;
  if (dot < 0) {
    dot = -dot;
    sinEnd = -sinEnd;
    cosEnd = -cosEnd;
  }
  let weightStart: number;
  let weightEnd: number;
  if (1 - dot > 0.0001) {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    weightStart = Math.sin(theta * (1 - t)) / sinTheta;
    weightEnd = Math.sin(theta * t) / sinTheta;
  } else {
    weightStart = 1 - t;
    weightEnd = t;
  }
  const interpSin = sinStart * weightStart + sinEnd * weightEnd;
  const interpCos = cosStart * weightStart + cosEnd * weightEnd;
  const out = Math.atan2(interpSin, interpCos);
  return out + out;
}

export { DEG };
