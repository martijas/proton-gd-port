// What a death that got somewhere shows over the level: the "New Best!" pop-up
// with its percentage and the orbs it paid, and the counter in the top-right
// corner the orbs fly to.
//
// Both are the game's own layers on the PlayLayer, timed by its actions:
// PlayLayer::showNewBest for the pop-up, CurrencyRewardLayer for the orbs.
// They live on the play screen, which steps and draws them; neither stops the
// level, and the counter outlives the attempt it was for.

import { FRAMES } from "./art";
import { label, type ArtLookup } from "./chrome";
import type { Tint } from "./draw";
import type { Widget } from "./widgets";

/** The pop-up's node starts and ends this small. [showNewBest :89597 (setScale 0.01)] */
const TINY = 0.01;
/** Growing in, elastic, over 0.4 s with a period of 0.6. [:89598-89599] */
const GROW = 0.4;
const GROW_PERIOD = 0.6;
/** Shrinking away over 0.2 s, eased in at rate 2. [:89601-89602] */
const SHRINK = 0.2;
/** The dark sheet behind a pop-up that pays: up to 100 of 255 over 0.3 s, away over 0.4 s. [:89610-89614] */
const DIM_IN = 0.3;
const DIM_OUT = 0.4;
const DIM_ALPHA = 100 / 255;
const BLACK: Tint = { r: 0, g: 0, b: 0 };

/** cocos2d's CCEaseElasticOut. */
export function elasticOut(t: number, period: number): number {
  if (t <= 0 || t >= 1) return Math.min(1, Math.max(0, t));
  return Math.pow(2, -10 * t) * Math.sin(((t - period / 4) * Math.PI * 2) / period) + 1;
}

/** cocos2d's CCEaseInOut at `rate`. */
export function easeInOut(t: number, rate: number): number {
  const u = t * 2;
  return u < 1 ? 0.5 * Math.pow(u, rate) : 1 - 0.5 * Math.pow(2 - u, rate);
}

export interface NewBestSpec {
  /** Whether the attempt beat the best; without that the pop-up says it paid. */
  newBest: boolean;
  /** The whole percentage the attempt died at. */
  percent: number;
  orbs: number;
}

/**
 * The pop-up: GJ_newBest_001 standing on the middle of the screen, 20 above
 * it (30 when it pays), the percentage under it at 1.1, and the orbs under
 * that at 0.6 with their icon beside them. It grows in, holds 0.7 s (1.3 s
 * when it pays), and shrinks away; one that pays darkens the level behind it
 * while it shows. Without a new best it says "New Reward!" instead.
 * [gdp PlayLayer::showNewBest :88991-89618]
 */
export class NewBestPopup {
  private t = 0;
  private readonly hold: number;

  constructor(readonly spec: NewBestSpec) {
    this.hold = spec.orbs > 0 ? 1.3 : 0.7;
  }

  update(dt: number): void {
    this.t += dt;
  }

  get done(): boolean {
    const end = GROW + this.hold + SHRINK;
    return this.t >= (this.spec.orbs > 0 ? Math.max(end, DIM_IN + this.hold + 0.3 + DIM_OUT) : end);
  }

  /** The node's scale now; 0 once it has gone. */
  scale(): number {
    const t = this.t;
    if (t < GROW) return TINY + (1 - TINY) * elasticOut(t / GROW, GROW_PERIOD);
    if (t < GROW + this.hold) return 1;
    const u = (t - GROW - this.hold) / SHRINK;
    if (u >= 1) return 0;
    return 1 + (TINY - 1) * u * u;
  }

  /** How dark the sheet behind it is now. [:89608-89616] */
  dim(): number {
    if (this.spec.orbs <= 0) return 0;
    const t = this.t;
    if (t < DIM_IN) return DIM_ALPHA * (t / DIM_IN);
    const out = DIM_IN + this.hold + 0.3;
    if (t < out) return DIM_ALPHA;
    return Math.max(0, DIM_ALPHA * (1 - (t - out) / DIM_OUT));
  }

  /** Where the node stands. [:89052-89060] */
  centre(width: number, height: number): { x: number; y: number } {
    return { x: width / 2, y: height / 2 + 20 + (this.spec.orbs > 0 ? 10 : 0) };
  }

  widgets(art: ArtLookup, width: number, height: number): Widget[] {
    const out: Widget[] = [];
    const dim = this.dim();
    if (dim > 0) out.push({ kind: "fill", rect: { x: 0, y: 0, w: width, h: height }, tint: BLACK, alpha: dim });
    const s = this.scale();
    if (s <= 0) return out;
    const c = this.centre(width, height);
    const at = (x: number, y: number): [number, number] => [c.x + x * s, c.y + y * s];
    if (this.spec.newBest) {
      const [x, y] = at(0, 0);
      out.push({ kind: "sprite", x, y, frame: FRAMES.newBest, scale: s, originX: 0.5, originY: 0 });
    } else {
      const [x, y] = at(0, 5);
      out.push(label(art, "New Reward!", x, y, { font: "goldFont", scale: 1.2 * s, anchorY: 0 }));
    }
    const [px, py] = at(0, -4);
    out.push(label(art, `${this.spec.percent}%`, px, py, { scale: 1.1 * s, anchorY: 1 }));
    if (this.spec.orbs > 0) {
      // The amount and its icon centred together, 5 left of the middle, 62
      // down. [:89480-89545 (the orbs alone: v70, v32 = −5)]
      const text = `+${this.spec.orbs}`;
      const lw = art.measure?.("bigFont", text, { scale: 0.6 }).width ?? 0;
      const iw = art.quad(FRAMES.orb)?.w ?? 0;
      const lx = -((lw + 5 + iw) * 0.5 - lw * 0.5) - 5;
      const [ax, ay] = at(lx, -62);
      out.push(label(art, text, ax, ay, { scale: 0.6 * s }));
      const [ix, iy] = at(lx + lw * 0.5 + 5, -62.5);
      out.push({ kind: "sprite", x: ix, y: iy, frame: FRAMES.orb, scale: s, originX: 0, originY: 0.5 });
    }
    return out;
  }
}

/** The counter's colour. [CurrencyRewardLayer::init :539320-539323] */
const COUNTER_TINT: Tint = { r: 150, g: 255, b: 255 };
/** The counter stands 40 in from the right and 5 down, and slides there from 40 higher over half the layer's time. [:539290, :540147-540157] */
const COUNTER_IN = 40;
/** The layer's time scale. [PlayLayer::showNewBest :89587 (0.9)] */
const PACE = 0.9;
/** Most orbs flown one each; the rest ride on random ones. [createObjectsFull, v32 == 60] */
const MOST_ORBS = 60;

interface FlyingOrb {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds of bouncing left before it makes for the counter. */
  life: number;
  speed: number;
  tx: number;
  ty: number;
  worth: number;
  scale: number;
  /** Seconds since it reached the counter, shrinking away; −1 while flying. */
  gone: number;
}

/**
 * The counter the orbs fly to: the orb total before the reward at 0.6, with
 * the orb icon beside it, sliding in at the top-right. Each orb leaves the
 * pop-up a little apart from the rest, bounces about the screen under
 * gravity for most of a second, then makes for the icon faster and faster;
 * the count goes up as each lands and the icon swells. When the last has
 * landed the level is told (the game resets on it), and the counter swells
 * once and slides away up.
 * [gdp CurrencyRewardLayer::init :539264-540210, createObjectsFull
 *  :538637-538900, update :537999-538262, incrementCount :537759,
 *  pulseSprite :537501; PlayLayer::currencyWillExit]
 */
export class OrbReward {
  private t = 0;
  private count: number;
  private readonly orbs: FlyingOrb[] = [];
  private readonly home: { x: number; y: number };
  private readonly icon: { x: number; y: number };
  private pulse = -1;
  private exitAt = -1;

  constructor(
    before: number,
    orbs: number,
    from: { x: number; y: number },
    private readonly width: number,
    private readonly height: number,
    art: ArtLookup,
    private readonly onExit: () => void,
    rand: () => number = Math.random,
  ) {
    this.count = before;
    this.home = { x: width - 40, y: height - 5 };
    const lh = art.measure?.("bigFont", String(before), { scale: 0.6 }).height ?? 19;
    this.icon = { x: this.home.x + 15, y: this.home.y - 0.5 - lh * 0.5 };
    // How long the orbs bounce, and how far that spreads, by how many.
    // [createObjectsFull :538660-538720]
    let base = PACE;
    let spread = PACE * 0.3;
    let scale = 1;
    if (orbs <= 9) {
      base = 0.8;
      spread = 0.2;
    } else {
      if (orbs > 400) spread = 0.9;
      else if (orbs > 300) spread = 0.8;
      else if (orbs > 200) spread = 0.7;
      else if (orbs > 100) spread = 0.6;
      else if (orbs > 50) spread = 0.5;
      else if (orbs >= 31) spread = 0.4;
      scale = orbs > 300 ? 0.8 : orbs > 50 ? 0.9 : orbs >= 21 ? 0.95 : 1;
    }
    const life = base + PACE * 0.1;
    const signed = (): number => rand() * 2 - 1;
    for (let i = 0; i < Math.min(orbs, MOST_ORBS); i++) {
      this.orbs.push({
        x: from.x + signed() * 10,
        y: from.y + signed() * 10,
        vy: rand() * 3 * 4,
        vx: rand() * 5 * (rand() <= 0.5 ? -1 : 1),
        life: life + rand() * spread,
        speed: 0,
        tx: this.icon.x + signed() * 10,
        ty: this.icon.y,
        worth: 1,
        scale,
        gone: -1,
      });
    }
    for (let i = MOST_ORBS; i < orbs; i++) {
      const orb = this.orbs[Math.floor(rand() * this.orbs.length)];
      orb.worth++;
      if (orb.scale < 3) orb.scale += 0.1;
    }
    if (this.orbs.length === 0) this.exitAt = 0;
  }

  /** Gone: every orb landed and the counter has slid away. */
  get done(): boolean {
    return this.exitAt >= 0 && this.t - this.exitAt >= 0.4 + 0.5 * PACE;
  }

  update(dt: number, rand: () => number = Math.random): void {
    this.t += dt;
    if (this.pulse >= 0) this.pulse += dt;
    const step = dt * 60;
    const top = this.height - 6;
    const right = this.width - 6;
    let flying = 0;
    for (const orb of this.orbs) {
      if (orb.gone >= 0) {
        orb.gone += dt;
        continue;
      }
      flying++;
      orb.life -= dt;
      if (orb.life > 0) {
        orb.vy -= step * 0.4;
        let x = orb.x + orb.vx * step;
        let y = orb.y + orb.vy * step;
        if (y > top) {
          y = top;
          orb.vy *= -0.6 - rand() * 0.3;
        } else if (y < 6) {
          y = 6;
          orb.vy *= -0.6 - rand() * 0.3;
          if (orb.vy < 4) orb.vy = rand() * 2 + 4;
        }
        if (x < 6 || x > right) {
          x = x < 6 ? 6 : right;
          orb.vx *= -0.9;
        }
        orb.x = x;
        orb.y = y;
        continue;
      }
      const dx = orb.tx - orb.x;
      const dy = orb.ty - orb.y;
      const d = Math.hypot(dx, dy);
      if (d <= 5) {
        orb.gone = 0;
        this.count += orb.worth;
        this.pulse = 0;
        continue;
      }
      const k = (d / 10 + 10) / orb.speed;
      const mx = (dx / k) * step;
      const my = (dy / k) * step;
      orb.x += Math.abs(mx) < Math.abs(dx) ? mx : dx;
      orb.y += Math.abs(my) < Math.abs(dy) ? my : dy;
      orb.speed += (step * 0.1) / PACE;
    }
    if (flying > 0 && this.orbs.every((o) => o.gone >= 0) && this.exitAt < 0) {
      this.exitAt = this.t;
      this.onExit();
    }
  }

  widgets(art: ArtLookup): Widget[] {
    const out: Widget[] = [];
    // In from above, then — once the last orb is home — a swell and away up.
    const slide = Math.min(1, this.t / (PACE * 0.5));
    let y = this.home.y + COUNTER_IN * (1 - easeInOut(slide, 2));
    let s = 1;
    if (this.exitAt >= 0) {
      const u = this.t - this.exitAt;
      if (u < 0.2) s = 1 + 0.2 * easeInOut(u / 0.2, 2);
      else if (u < 0.4) s = 1.2 - 0.2 * easeInOut((u - 0.2) / 0.2, 2);
      else y += 50 * easeInOut(Math.min(1, (u - 0.4) / (0.5 * PACE)), 2);
    }
    const x = this.home.x;
    out.push(label(art, String(this.count), x, y, { scale: 0.6 * s, anchorX: 1, anchorY: 1, tint: COUNTER_TINT }));
    // The icon swells to 1.5 and back over 0.16 s as each orb lands. [pulseSprite]
    let pulse = 1;
    if (this.pulse >= 0 && this.pulse < 0.16) {
      pulse = this.pulse < 0.08 ? 1 + 0.5 * Math.pow(this.pulse / 0.08, 1 / 1.8) : 1.5 - 0.5 * Math.pow((this.pulse - 0.08) / 0.08, 1.8);
    }
    out.push({ kind: "sprite", x: x + (this.icon.x - x) * s, y: y + (this.icon.y - this.home.y) * s, frame: FRAMES.orb, scale: pulse * s });
    for (const orb of this.orbs) {
      if (orb.gone >= 0.1) continue;
      const shrink = orb.gone >= 0 ? 1 + (0.1 - 1) * (orb.gone / 0.1) : 1;
      out.push({ kind: "sprite", x: orb.x, y: orb.y, frame: FRAMES.flyingOrb, scale: orb.scale * shrink });
    }
    return out;
  }
}
