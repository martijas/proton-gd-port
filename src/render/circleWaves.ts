// The game's circle waves: the discs and rings that grow or shrink and fade
// where an orb is taken, a pad bounces the player, a portal changes something,
// a spider jumps, a coin is picked up, the player dies.
//
// Every one is a CCCircleWave, a node of the game's own. It tweens two numbers
// — its radius and its opacity — and draws one shape with cocos's primitive
// calls: a filled circle (ccDrawFilledCircle, a triangle fan) or, with its
// outline flag set, a line strip glLineWidth pixels wide (ccDrawCircle). The
// circle is a polygon of 10 to 50 sides, by its radius. It is drawn additive,
// GL_SRC_ALPHA / GL_ONE on a flat colour, so it adds its colour times its
// opacity. Made with fadeIn, the opacity rises from 0 to 255 over the first
// half and falls back over the second, while the radius goes in a straight
// line; made without it, the opacity falls from 255 to 0 alongside the
// radius, both eased out (rate 2) when asked. When the tweens are done the
// circle removes itself.
//
// The simulation says when the game makes one and why (SimWave); this file
// says what each looks like, which is a fixed table per caller, and draws
// them. Nearly every one is a child of the object layer at a z of its own —
// 0 for nearly all — so the scene draws them among the batches and the
// particle systems by that z (batchNodes.drawLayerRuns). The ring a dual's
// leaving player makes is the game layer's own child instead, on the screen
// over the whole level.
//
// Callers not made yet, each waiting on what it belongs to:
// - GJBaseGameLayer::checkRepellPlayer :430322-430395, which the simulation
//   does not run: two dual balls of one gravity, closer than their half
//   sizes and 5, turn one over, a physics change of its own. Its 4-pixel
//   ring, from r + 2 to 4r (r its half size, 15 times its scale) in 0.3 s,
//   straight, in that player's colour 1, is on the player that stays (the
//   one +2044 marks), following it (exe VA 0x140239abb).
// - the leaving player's ghost in playExitDualEffect, a SimplePlayer of its
//   icon over the ring at z 100, fading out, shrinking to a tenth and
//   turning half a turn in 0.4 s: only the ring, which follows its path, is
//   drawn.
// Level-complete circles are made (completeEffectWaves → scene.spawnCompleteWaves).
//
// [gdp CCCircleWave::baseSetup :59911-59925, init :59939-60030 (the tweens),
//  draw :59683-59780, updateTweenAction :59826-59870, followObject
//  :60093-60110, updatePosition :59503-59515; the 2.2074 exe's draw, VA
//  0x140042e40-0x140042f6f, and create, 0x140042870, which every caller
//  calls with both of its flags (fadeIn in r9b, easeOut on the stack);
//  libcocos2d.dll ccDrawFilledCircle VA 0x180011230 (GL_TRIANGLE_FAN over
//  segments + 1 points from angle 0), ccDrawCircle 0x180010a40
//  (GL_LINE_STRIP)]

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS, SHAPE, SHAPE_BYTE } from "../engine/gl/spriteBatch";
import type { OrbType, PadType, SimWave } from "../physics/types";
import { CHANNEL, channelOpacityMod, type Rgb } from "./colors";
import type { EffectQuad } from "./effects";
import { slotOfZ, type CountedRuns } from "./batchNodes";
import { LAYER_Z } from "../triggers/shaderState";

/** One circle as its caller sets it up. */
export interface WaveSpec {
  /** The radius it starts at and ends at, in units. */
  from: number;
  to: number;
  /** Seconds the tweens take. */
  duration: number;
  /** The opacity rises from 0 to 255 over the first half and falls back over the second. */
  fadeIn: boolean;
  /** CCEaseOut at rate 2 on both tweens; only read without fadeIn. */
  easeOut: boolean;
  colour: Rgb;
  /** A ring (+292) rather than a disc. */
  outline: boolean;
  /** The ring's glLineWidth (+296), in pixels. */
  lineWidth: number;
  /** +300, which the opacity is multiplied by as it is drawn. */
  opacityMod: number;
  /** Its z among its parent's children. */
  z: number;
  /**
   * Its parent: the object layer, or the game layer itself, whose children
   * stand on the screen over the whole level, in the screen's units.
   */
  layer: "object" | "game";
  /**
   * Made by a scheduled call (CCDelayTime, then a CCCallFunc) rather than
   * there and then, `delay` seconds on.
   */
  scheduled: boolean;
  delay: number;
}

/** What a circle stays centred on. */
export type WaveFollow =
  /** Where it was made. */
  | { kind: "none" }
  /** An object, at the offset it was made at. */
  | { kind: "object"; index: number; dx: number; dy: number }
  /** A player. */
  | { kind: "player"; which: 1 | 2 }
  /**
   * A game-layer node made where the circle was, sliding (dx, dy) screen
   * units in a straight line over `duration` seconds of the circle's own
   * clock (CCMoveTo): the exit dual's ghost.
   */
  | { kind: "ghost"; dx: number; dy: number; duration: number };

/** One circle to make: how it looks, where, and what it follows. */
export interface WaveSpawn {
  spec: WaveSpec;
  x: number;
  y: number;
  follow: WaveFollow;
}

/** baseSetup's defaults: a white disc at full opacity, a 2-pixel line for a ring. [:59911-59925] */
const DEFAULT_LINE_WIDTH = 2;
/** The z almost every caller adds its circle at. */
const WAVE_Z = 0;

function spec(from: number, to: number, duration: number, fadeIn: boolean, easeOut: boolean, colour: Rgb, more: Partial<WaveSpec> = {}): WaveSpec {
  return { from, to, duration, fadeIn, easeOut, colour, outline: false, lineWidth: DEFAULT_LINE_WIDTH, opacityMod: 1, z: WAVE_Z, layer: "object", scheduled: false, delay: 0, ...more };
}

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

const WHITE = rgb(255, 255, 255);

/**
 * The colour of the circle a taken orb makes, by its type. The black orb
 * takes the light background's colour (1007) and the toggle orb its own;
 * those two are null here. [gdp PlayerObject::ringJump :159962-160061: 11
 *  yellow and the rest LABEL_175, 12 and 38 magenta, 13 cyan, 29 and 37
 *  green, 35 orange, 36 its sprite's colour, 32 channel 1007, 43 pink]
 */
export const ORB_WAVE_COLOURS: Readonly<Record<OrbType, Rgb | null>> = {
  yellow: rgb(255, 200, 0),
  pink: rgb(255, 0, 255),
  red: rgb(255, 100, 0),
  blue: rgb(0, 255, 255),
  green: rgb(0, 255, 0),
  black: null,
  spider: rgb(255, 50, 255),
  dash: rgb(0, 255, 0),
  dashGravity: rgb(255, 0, 255),
  toggle: null,
  teleport: rgb(255, 200, 0),
};

/**
 * A pad's circle colour. The red pad's is the yellow pad's. [gdp
 *  PlayerObject::playBumpEffect :147290-147313: 10 cyan, 44 pink, 9 magenta,
 *  anything else yellow]
 */
export const PAD_WAVE_COLOURS: Readonly<Record<PadType, Rgb>> = {
  yellow: rgb(255, 200, 0),
  red: rgb(255, 200, 0),
  pink: rgb(255, 0, 255),
  blue: rgb(0, 255, 255),
  spider: rgb(255, 50, 255),
};

/**
 * The portal circles (spawnPortalCircle), by what made them: the colour the
 * caller hands over and the radius it starts from. Each shrinks to 5 in 0.3 s,
 * fading in and out. [gdp PlayerObject::spawnPortalCircle :143138-143190;
 *  its callers: toggleFlyMode :152870-152874 (ship), toggleBirdMode
 *  :152970-152974 (UFO), toggleDartMode :153049-153053 (wave),
 *  toggleSwingMode :152599-152603, toggleRollMode :153153-153157 (ball),
 *  toggleRobotMode :153258-153262, toggleSpiderMode :152754-152758;
 *  flipGravity :151159-151175 (45, yellow up, blue down); togglePlayerScale
 *  :150483-150496 (45); GJBaseGameLayer::toggleFlipped :449106-449126;
 *  toggleDualMode :462685-462690 (solo); teleportPlayer :462381-462426]
 */
export const PORTAL_WAVES: Readonly<Record<string, { colour: Rgb; radius: number }>> = {
  ship: { colour: rgb(255, 0, 255), radius: 50 },
  ufo: { colour: rgb(255, 200, 0), radius: 50 },
  wave: { colour: rgb(255, 200, 0), radius: 50 },
  swing: { colour: rgb(255, 200, 0), radius: 50 },
  ball: { colour: rgb(255, 50, 50), radius: 50 },
  robot: { colour: rgb(255, 50, 50), radius: 50 },
  spider: { colour: rgb(255, 50, 50), radius: 50 },
  gravityUp: { colour: rgb(255, 200, 0), radius: 45 },
  gravityDown: { colour: rgb(0, 150, 255), radius: 45 },
  mini: { colour: rgb(255, 0, 150), radius: 45 },
  normal: { colour: rgb(0, 255, 150), radius: 45 },
  mirrorOn: { colour: rgb(255, 150, 0), radius: 50 },
  mirrorOff: { colour: rgb(0, 255, 255), radius: 50 },
  solo: { colour: rgb(0, 255, 100), radius: 50 },
  teleportIn: { colour: rgb(0, 255, 255), radius: 50 },
  teleportOut: { colour: rgb(255, 200, 0), radius: 50 },
};

/**
 * A speed portal's ring, by its speed (0 slow to 4 fastest): the radius it
 * grows to and its colour. [gdp GameObject::playShineEffect :168049-168090
 *  (the colours, by id 200-203 and 1334), :168200-168255 (the radii)]
 */
export const SPEED_WAVES: readonly { colour: Rgb; radius: number }[] = [
  { colour: rgb(255, 255, 0), radius: 60 },
  { colour: rgb(0, 150, 255), radius: 65 },
  { colour: rgb(0, 255, 150), radius: 70 },
  { colour: rgb(255, 0, 255), radius: 80 },
  { colour: rgb(255, 50, 50), radius: 90 },
];

/**
 * Option 0061, "Switch spider teleport color": the spider's dash in the
 * player's colour 1 rather than 2. The port has no such option, so it is the
 * game's default, off. [gdp PlayerObject::init :162573-162575 (+2169);
 *  playSpiderDashEffect :145804-145808]
 */
const SPIDER_DASH_COLOUR_1 = false;

/**
 * How far the exit dual's ghost slides across the screen, leftwards (to the
 * right in a mirrored view). [exe VA 0x1402172e5, the float at 0x140623a20;
 *  playExitDualEffect :421135]
 */
const EXIT_GHOST_SLIDE = 124.63203430175781;
/** How far right of the player a mirrored view puts the ghost. [:421110-421121] */
const EXIT_MIRROR_SHIFT = 150;

/**
 * The opacity, 0 to 255, GameObject::setOpacity gives a sprite in full view
 * (the enter effects' fade at the screen's edges left out): its channel's
 * opacity as opacityModForMode wears it (`channelAlpha`; a channel of 0 or
 * less counts as whole) times its groups' (groupOpacityMod, which gives up
 * at 0 once the product gets there), truncated to a byte.
 * [GameObject::setOpacity :167614-167646 (+952's +8); updateVisibility
 *  :95919-95925 (opacityModForMode of the main channel, +556);
 *  opacityModForMode :172788-172807; groupOpacityMod :170161-170181]
 */
export function shownOpacity(channelAlpha: number, groups: readonly number[], groupAlpha: (group: number) => number): number {
  let mod = channelOpacityMod(channelAlpha);
  if (groups.length > 0) {
    let product = 1;
    for (const g of groups) {
      product *= groupAlpha(g);
      if (product <= 0) {
        product = 0;
        break;
      }
    }
    mod *= product;
  }
  const v = 255 * mod;
  return v > 0 ? Math.trunc(v) & 255 : 0;
}

/** What the circles read off the scene when they are made. */
export interface WaveContext {
  /** The game's Low Detail Mode (GameManager +669, "performanceMode"), which leaves out most of them. */
  readonly performanceMode: boolean;
  /** Player `which`'s colour 1 or 2 as its icon wears it (PlayerObject +2122 and +2125). */
  playerColour(which: 1 | 2, slot: 1 | 2): Rgb;
  /** A colour channel's colour now. */
  channelColour(id: number): Rgb;
  /** Object `index`'s colour as getColor gives it: its colour sprite's if it has one, its own otherwise. */
  objectColour(index: number): Rgb;
  /** Where object `index` is now, in level space. */
  objectPosition(index: number): readonly [number, number];
  /** The z of the batch object `index`'s own sprite is in. */
  objectBatchZ(index: number): number;
  /** Where a linked teleport's exit stands from the portal. */
  linkedExitOffset(index: number): readonly [number, number];
  /** Whether player `which` is shown (PlayerObject +1483 clear). */
  playerShown(which: 1 | 2): boolean;
  /**
   * Object `index`'s opacity as its sprite was last given it (shownOpacity):
   * its main sprite's, or with `detail` its colour sprite's (+748), -1 when
   * it has none.
   */
  spriteOpacity(index: number, detail: boolean): number;
  /**
   * Level point (x, y) in the game layer, in screen units from the bottom
   * left: less the corner of the view the step ran under (+852), times the
   * zoom (+328). The view's turn and shake are not in it, as they move only
   * the layers the level is in.
   */
  toScreen(x: number, y: number): readonly [number, number];
}

/** A circle centred on object `index`, following it from where (x, y) puts it. */
function onObject(s: WaveSpec, index: number, x: number, y: number, ctx: WaveContext): WaveSpawn {
  if (index < 0) return { spec: s, x, y, follow: { kind: "none" } };
  const [ox, oy] = ctx.objectPosition(index);
  return { spec: s, x, y, follow: { kind: "object", index, dx: x - ox, dy: y - oy } };
}

function onPlayer(s: WaveSpec, w: SimWave): WaveSpawn {
  return { spec: s, x: w.x, y: w.y, follow: { kind: "player", which: w.player } };
}

function fixed(s: WaveSpec, x: number, y: number): WaveSpawn {
  return { spec: s, x, y, follow: { kind: "none" } };
}

/**
 * The circles one SimWave makes, as its caller in the game makes them: none
 * where the game's own gates say so here, one or more otherwise.
 */
export function wavesFor(w: SimWave, ctx: WaveContext): WaveSpawn[] {
  const low = ctx.performanceMode;
  switch (w.cause) {
    case "ring": {
      // 42 for the red orb, 35 for the rest, to 5 in 0.35 s, fading in and
      // out, a disc on the orb. [PlayerObject::ringJump :159948-159955 (the
      //  gates), :160027-160050]
      if (low) return [];
      const type = w.variant as OrbType;
      let colour = ORB_WAVE_COLOURS[type];
      if (type === "black") colour = ctx.channelColour(CHANNEL.LIGHT_BG);
      else if (!colour) colour = w.object >= 0 ? ctx.objectColour(w.object) : WHITE;
      return [onObject(spec(type === "red" ? 42 : 35, 5, 0.35, true, true, colour), w.object, w.x, w.y, ctx)];
    }
    case "ringPower":
      // A white ring from 5 to 55 in 0.25 s, eased out, on the orb.
      // [RingObject::spawnCircle :306710-306750]
      if (low) return [];
      return [onObject(spec(5, 55, 0.25, false, true, WHITE, { outline: true }), w.object, w.x, w.y, ctx)];
    case "bump": {
      // From 10 — 12 for a full-size player on a red pad — to 40 in 0.25 s,
      // eased out, a disc on the pad. playBumpEffect puts it under the pad
      // and then follows the pad, which puts it on the pad.
      // [PlayerObject::playBumpEffect :147258-147336; GJBaseGameLayer::
      //  bumpPlayer :463186-463189 (+2032 the pad less 10, +2116 the pad)]
      if (low) return [];
      const type = w.variant as PadType;
      const from = w.size < 1 ? 10 : type === "red" ? 12 : 10;
      return [onObject(spec(from, 40, 0.25, false, true, PAD_WAVE_COLOURS[type] ?? PAD_WAVE_COLOURS.yellow), w.object, w.x, w.y, ctx)];
    }
    case "portal": {
      // A disc from the portal's radius down to 5 in 0.3 s, fading in and
      // out, on the object the player last met (SimWave.object), which it
      // follows. A linked teleport's exit is an object of the game's own
      // beside the portal, which it moves with.
      // [PlayerObject::spawnPortalCircle :143138-143190]
      if (low) return [];
      const look = PORTAL_WAVES[w.variant];
      if (!look) return [];
      let x = w.x;
      let y = w.y;
      if (w.exit && w.object >= 0) {
        const [dx, dy] = ctx.linkedExitOffset(w.object);
        x += dx;
        y += dy;
      }
      return [onObject(spec(look.radius, 5, 0.3, true, true, look.colour), w.object, x, y, ctx)];
    }
    case "scale":
      // Back to full size: from 10 to 40 in 0.3 s, eased out; to mini: from
      // 50 to 2 in 0.25 s, fading in and out. A disc on the player.
      // [PlayerObject::spawnScaleCircle :143210-143290; the exe's,
      //  VA 0x1403979eb-0x140397a5e]
      if (low) return [];
      return [
        onPlayer(
          w.variant === "mini" ? spec(50, 2, 0.25, true, true, rgb(255, 0, 150)) : spec(10, 40, 0.3, false, true, rgb(0, 255, 150)),
          w,
        ),
      ];
    case "dual":
      // From 50 to 2 in 0.25 s, fading in and out, in the player's colour 1.
      // [PlayerObject::spawnDualCircle :143297-143345]
      if (low) return [];
      return [onPlayer(spec(50, 2, 0.25, true, true, ctx.playerColour(w.player, 1)), w)];
    case "dart":
      // A ring 4 pixels wide from 10 to 60 in 0.4 s, eased out, in the
      // player's colour 1, left where the portal was. Low Detail Mode does
      // not stop it. [PlayerObject::toggleDartMode :153060-153078]
      return [fixed(spec(10, 60, 0.4, false, true, ctx.playerColour(w.player, 1), { outline: true, lineWidth: 4 }), w.x, w.y)];
    case "speed": {
      // A ring 6 pixels wide from 5 to the speed's radius in 0.3 s, eased
      // out, just under the batch the portal is drawn in; none for a portal
      // that is not drawn at all, its opacity 0. Low Detail Mode does not
      // stop it. [GameObject::playShineEffect :167956-167966 (vtable 440,
      //  the opacity), :168200-168250]
      if (w.object >= 0 && ctx.spriteOpacity(w.object, false) === 0) return [];
      const look = SPEED_WAVES[Number(w.variant)] ?? SPEED_WAVES[1];
      const z = w.object >= 0 ? ctx.objectBatchZ(w.object) - 1 : WAVE_Z;
      return [onObject(spec(5, look.radius, 0.3, false, true, look.colour, { outline: true, lineWidth: 6, z }), w.object, w.x, w.y, ctx)];
    }
    case "spiderDash": {
      // Three, in the player's colour 2: a disc shrinking from 13 to 1 in
      // 0.15 s where the jump began, and where it landed a disc from 26 to 2
      // and a ring from 10 to 45 in 0.25 s, all straight; the discs at
      // 0.42 and 0.84 of their opacity. Both ends are moved 7.5 the way the
      // player travels, and the landing 6 more to the right. Sizes go with
      // the player's. [PlayerObject::playSpiderDashEffect :145784-145870; the
      //  exe's, VA 0x1403951c1-0x140395585]
      if (low || !ctx.playerShown(w.player)) return [];
      const colour = ctx.playerColour(w.player, SPIDER_DASH_COLOUR_1 ? 1 : 2);
      const ahead = w.variant === "reversed" ? -7.5 : 7.5;
      const s = w.size;
      const fx = w.x + ahead;
      const tx = w.x2 + ahead + 6;
      return [
        fixed(spec(s * 10 * 1.3, 1, 0.15, false, false, colour, { opacityMod: 0.42 }), fx, w.y),
        fixed(spec(s * 20 * 1.3, 2, 0.25, false, false, colour, { opacityMod: 0.84 }), tx, w.y2),
        fixed(spec(s * 10, s * 30 * 1.5, 0.25, false, false, colour, { outline: true }), tx, w.y2),
      ];
    }
    case "pickup":
      // A disc from 12 to 2 in 0.3 s, straight, in the pickup's colour,
      // where it was; none when neither its sprite nor its colour sprite is
      // drawn, their opacity 0. [GameObject::shouldShowPickupEffects
      //  :622101-622108; spawnDefaultPickupParticle :622174-622190]
      if (w.object >= 0 && ctx.spriteOpacity(w.object, false) === 0 && ctx.spriteOpacity(w.object, true) <= 0) return [];
      return [fixed(spec(12, 2, 0.3, false, false, w.object >= 0 ? ctx.objectColour(w.object) : WHITE), w.x, w.y)];
    case "coin": {
      // A disc from 25 to 5 and a ring 4 pixels wide from 5 to 60, both in
      // 0.3 s, the ring eased out: gold and yellow for a secret coin, grey
      // and white for a user coin. [GameObject::playDestroyObjectAnim
      //  :622603-622660]
      const user = w.variant === "user";
      return [
        fixed(spec(25, 5, 0.3, false, false, user ? rgb(200, 200, 200) : rgb(255, 200, 0)), w.x, w.y),
        fixed(spec(5, 60, 0.3, false, true, user ? WHITE : rgb(255, 255, 0), { outline: true, lineWidth: 4 }), w.x, w.y),
      ];
    }
    case "death": {
      // The default death effect's disc, from 10 to 90 times the player's
      // size (a full-size player counts as 0.9) in 0.5 s, eased out, in its
      // colour 1, at z 99 in its parent. Not for a hidden player.
      // [PlayerObject::playerDestroyed :149958-149962; playDeathEffect
      //  :683101-683104 (the size), default :685500-685531; z 0x63 in the
      //  exe, VA 0x140383d06]
      if (!ctx.playerShown(w.player)) return [];
      const s = w.size >= 1 ? w.size * 0.9 : w.size;
      return [fixed(spec(s * 10, s * 90, 0.5, false, true, ctx.playerColour(w.player, 1), { z: 99 }), w.x, w.y)];
    }
    case "exitDual": {
      // A ring from 10 to 30 in 0.4 s, eased out, in the player's colour 1,
      // a child of the game layer at z 0: over the whole level, in screen
      // units, where the player is on the screen, 150 further right in a
      // mirrored view. It follows the player's ghost, which slides 124.63
      // to the left (to the right when mirrored) in a straight line over
      // the same 0.4 s. Nothing gates it, Low Detail Mode included.
      // [GJBaseGameLayer::playExitDualEffect :421107-421179; the exe's,
      //  VA 0x140217196-0x1402174b2: CCCircleWave::create at 0x140217412
      //  (10, 30, 0.4, not fading in, eased out), +0x160 the ring, added at
      //  z 0 at 0x140217445]
      const mirrored = w.variant === "mirrored";
      const [sx, sy] = ctx.toScreen(w.x + (mirrored ? EXIT_MIRROR_SHIFT : 0), w.y);
      return [
        {
          spec: spec(10, 30, 0.4, false, true, ctx.playerColour(w.player, 1), { outline: true, layer: "game" }),
          x: sx,
          y: sy,
          follow: { kind: "ghost", dx: mirrored ? EXIT_GHOST_SLIDE : -EXIT_GHOST_SLIDE, dy: 0, duration: 0.4 },
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * The four rings a player makes as it is put back after a reset: each from
 * 70 to 2 in 0.3 s, fading in and out, in its colour 1, on the player, a
 * tenth of a second apart. Low Detail Mode leaves them out.
 * [gdp PlayLayer::resetLevel :105947-105951 (not the level's first);
 *  PlayerObject::playSpawnEffect :143028-143070 → spawnCircle
 *  :140849-140890]
 */
export function spawnEffectWaves(which: 1 | 2, x: number, y: number, ctx: WaveContext): WaveSpawn[] {
  if (ctx.performanceMode) return [];
  const out: WaveSpawn[] = [];
  for (let i = 0; i < 4; i++) {
    out.push({
      spec: spec(70, 2, 0.3, true, true, ctx.playerColour(which, 1), { outline: true, scheduled: true, delay: i * 0.1 }),
      x,
      y,
      follow: { kind: "player", which },
    });
  }
  return out;
}

/**
 * How far the level-complete spawnCircle ring grows on the screen, matching
 * the exe's fixed 250 rather than getScreenRight (which varies with the
 * window). [exe VA 0x1403a87c9; showCompleteText's second ring :88681]
 */
const COMPLETE_RING_TO = 250;
/** playCompleteEffect's mid and last rings' opacity mod (+300 = 0.7). [exe 0x1403843e8] */
const COMPLETE_PLAYER_OPACITY = 0.7;

/**
 * The circles at the end of a level: showCompleteEffect's and showCompleteText's
 * rings at the end position, and each player's playCompleteEffect discs.
 * Low Detail Mode leaves none of them out. Key 460 (LevelEnd.effects false)
 * skips the call.
 * [gdp PlayLayer::showCompleteEffect → spawnCircle :88772, showCompleteText
 *  :88664 and :88681; levelComplete :92873 → PlayerObject::playCompleteEffect
 *  :681486-681512; exe VAs 0x1403a87c9, 0x1403a8cac, 0x1403a8d5a, 0x1403abf37,
 *  0x140384375, 0x1403843e8, 0x140384469]
 */
export function completeEffectWaves(
  endX: number,
  endY: number,
  players: readonly { which: 1 | 2; x: number; y: number }[],
  ctx: WaveContext,
): WaveSpawn[] {
  const c1 = ctx.playerColour(1, 1);
  const out: WaveSpawn[] = [
    // spawnCircle from showCompleteEffect: 10 → 250 in 0.5 s, fading in, eased
    // out, a 4-pixel ring at the end position.
    fixed(spec(10, COMPLETE_RING_TO, 0.5, true, true, c1, { outline: true, lineWidth: 4 }), endX, endY),
    // showCompleteText: 10 → screen (250) in 0.8 s, eased out, 4-pixel ring.
    fixed(spec(10, COMPLETE_RING_TO, 0.8, false, true, c1, { outline: true, lineWidth: 4 }), endX, endY),
    // showCompleteText's second: 10 → 250 in 0.8 s, eased out, 4-pixel ring.
    fixed(spec(10, COMPLETE_RING_TO, 0.8, false, true, c1, { outline: true, lineWidth: 4 }), endX, endY),
  ];
  for (const p of players) {
    const colour1 = ctx.playerColour(p.which, 1);
    const colour2 = ctx.playerColour(p.which, 2);
    // playCompleteEffect: three discs on the player, eased out.
    out.push(
      { spec: spec(20, 80, 0.72, false, true, colour1), x: p.x, y: p.y, follow: { kind: "player", which: p.which } },
      {
        spec: spec(30, 50, 0.84, false, true, colour2, { opacityMod: COMPLETE_PLAYER_OPACITY, z: 1000 }),
        x: p.x,
        y: p.y,
        follow: { kind: "player", which: p.which },
      },
      {
        spec: spec(30, 20, 0.96, false, true, colour1, { opacityMod: COMPLETE_PLAYER_OPACITY, z: 1000 }),
        x: p.x,
        y: p.y,
        follow: { kind: "player", which: p.which },
      },
    );
  }
  return out;
}

/**
 * The radius and opacity (0 to 255) `elapsed` seconds into a circle's tweens.
 * A tween runs from its start to its end as the time does; CCEaseOut at rate
 * 2 runs it on the square root of the time instead. With fadeIn the opacity
 * is two tweens of half the time each, up and then down, and nothing is
 * eased. [CCCircleWave::init :59966-60030; cocos2d::CCActionTween::update
 *  (to − delta × (1 − t)), CCEaseOut::update (t^(1 / rate)),
 *  CCSequence::update (the split at half)]
 */
export function waveState(s: WaveSpec, elapsed: number, out: WaveState = { radius: 0, opacity: 0 }): WaveState {
  const t = s.duration > 0 ? Math.min(1, Math.max(0, elapsed / s.duration)) : 1;
  if (s.fadeIn) {
    out.radius = s.from + (s.to - s.from) * t;
    out.opacity = t < 0.5 ? 255 * (t / 0.5) : 255 - 255 * ((t - 0.5) / 0.5);
    return out;
  }
  const e = s.easeOut ? Math.sqrt(t) : t;
  out.radius = s.from + (s.to - s.from) * e;
  out.opacity = 255 - 255 * e;
  return out;
}

/** A circle's radius and opacity at a moment (waveState). */
export interface WaveState {
  radius: number;
  opacity: number;
}

/** How many sides the circle has at `radius`. [CCCircleWave::draw :59718-59738] */
export function circleSegments(radius: number): number {
  if (radius < 10) return 10;
  if (radius < 20) return 15;
  if (radius < 40) return 20;
  if (radius >= 200) return 50;
  return 30;
}

/** The alpha byte it is drawn with: its opacity times +300, held to 0..255 and truncated. [:59700-59713] */
export function waveAlpha(opacity: number, mod: number): number {
  const v = opacity * mod;
  if (!(v > 0)) return 0;
  return v < 255 ? Math.trunc(v) : 255;
}

/** One circle as it lives. */
interface LiveWave {
  spec: WaveSpec;
  follow: WaveFollow;
  x: number;
  y: number;
  /** Seconds of its tweens gone by. */
  elapsed: number;
  /** A scheduled one not made yet. */
  pending: boolean;
  /** Seconds it still waits, while pending. */
  wait: number;
  /** Its delay has yet to take its first step, which moves nothing. */
  waitFresh: boolean;
  /** Updates still to pass before its tweens start moving (see `add`). */
  holds: number;
  /** For ordering ties by arrival. */
  order: number;
}

/** The object layer's circles first, each layer's by z, ties by arrival. */
function drawOrder(a: LiveWave, b: LiveWave): number {
  return (a.spec.layer === "game" ? 1 : 0) - (b.spec.layer === "game" ? 1 : 0) || a.spec.z - b.spec.z || a.order - b.order;
}

/** build's scratch, as it runs every frame a circle is alive. */
const STATE: WaveState = { radius: 0, opacity: 0 };
const POINT: number[] = [0, 0];

/** Where the scene's things are this frame, for the circles that follow them. */
export interface WaveScene {
  /** Where object `index` is now; the pair may be reused by the next call. */
  objectPosition(index: number): readonly [number, number];
  /** The player as drawn this frame, or null when there is none. */
  playerPosition(which: 1 | 2): { x: number; y: number } | null;
  /**
   * A place in the game layer, in screen units from the bottom left, as the
   * level point drawn there this frame, into `out`: the view's centre, zoom,
   * turn and shake undone, as the game layer's own children take none of
   * them.
   */
  screenToLevel(sx: number, sy: number, out: number[]): void;
  /** Screen units per level unit this frame: the zoom. */
  zoom: number;
  /** Level units per pixel of the target, for a ring's line width. */
  unitsPerPixel: number;
  /** What is in view, padded; circles wholly outside it are not drawn. */
  view: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * The circles alive in a level: made from what the simulation reported,
 * stepped with the level's clock, and baked into instances by z for the
 * scene to draw among the object layer's batches.
 */
export class CircleWaves implements CountedRuns {
  private readonly live: LiveWave[] = [];
  private made = 0;
  private data = new Float32Array(512 * INSTANCE_FLOATS);
  private bytes = new Uint8Array(this.data.buffer);
  private count = 0;
  runZ = new Int16Array(16);
  runStart = new Int32Array(16);
  runCount = new Int32Array(16);
  readonly layerRunFirst = new Int32Array(LAYER_Z.length);
  readonly layerRuns = new Int32Array(LAYER_Z.length);
  runs = 0;
  private readonly order: LiveWave[] = [];
  /** The first game-layer instance of the last build (gameStart). */
  private gameFrom = 0;

  /** How many are alive, made or still waiting. */
  get size(): number {
    return this.live.length;
  }

  /** The last build's instances. */
  get buffer(): Float32Array {
    return this.data;
  }

  get instances(): number {
    return this.count;
  }

  add(w: WaveSpawn): void {
    const scheduled = w.spec.scheduled;
    this.live.push({
      spec: w.spec,
      follow: w.follow,
      x: w.x,
      y: w.y,
      elapsed: 0,
      pending: scheduled,
      wait: scheduled ? w.spec.delay : 0,
      waitFresh: true,
      // Made in the middle of the game's update, after the frame's actions
      // have run, a circle is drawn as made that frame; the next frame its
      // tweens take their first step, which moves nothing; they move from
      // the frame after. One made by a scheduled call is made inside the
      // actions' own pass, which takes that first step there and then.
      // [cocos2d::CCActionInterval::step (the first tick sets elapsed to 0);
      //  CCScheduler runs CCActionManager::update first, at kCCPrioritySystem]
      holds: 2,
      order: this.made++,
    });
  }

  clear(): void {
    this.live.length = 0;
    this.clearBuild();
  }

  /** Forgets the last build, for a frame that draws none. */
  clearBuild(): void {
    this.count = 0;
    this.runs = 0;
    this.gameFrom = 0;
    this.layerRuns.fill(0);
  }

  /**
   * Steps every circle by `dt` seconds of the level's clock; 0 is a frozen
   * frame, which moves nothing. A circle whose tweens are done is gone, as
   * its last action removes it.
   */
  update(dt: number): void {
    if (!(dt > 0)) return;
    let keep = 0;
    for (const w of this.live) {
      if (w.pending) {
        // The delay's own first step moves nothing either.
        if (w.waitFresh) w.waitFresh = false;
        else w.wait -= dt;
        if (w.wait > 0) {
          this.live[keep++] = w;
          continue;
        }
        w.pending = false;
        w.holds = 1;
      }
      if (w.holds > 0) w.holds--;
      else w.elapsed += dt;
      if (w.elapsed >= w.spec.duration) continue;
      this.live[keep++] = w;
    }
    this.live.length = keep;
  }

  /**
   * Bakes the circles into instances on the flat white square: the object
   * layer's in z order (ties by arrival), filed into runs by z the way the
   * particle field does, then the game layer's (gameStart). Returns how many
   * instances there are.
   */
  build(quad: EffectQuad, scene: WaveScene): number {
    this.count = 0;
    this.runs = 0;
    this.gameFrom = 0;
    this.layerRunFirst.fill(0);
    this.layerRuns.fill(0);
    const order = this.order;
    order.length = 0;
    for (const w of this.live) if (!w.pending) order.push(w);
    if (order.length === 0) return 0;
    order.sort(drawOrder);
    // The centre of the square, so every corner samples the same white texel.
    const u = quad.u0 + quad.du / 2;
    const v = quad.v0 + quad.dv / 2;
    let game = false;
    for (const w of order) {
      let x = w.x;
      let y = w.y;
      // Level units per unit of the circle's own: a game-layer circle's
      // are the screen's.
      let scale = 1;
      const f = w.follow;
      if (w.spec.layer === "game") {
        if (!game) {
          game = true;
          this.gameFrom = this.count;
        }
        if (f.kind === "ghost") {
          const t = f.duration > 0 ? Math.min(1, w.elapsed / f.duration) : 1;
          x += f.dx * t;
          y += f.dy * t;
        }
        scene.screenToLevel(x, y, POINT);
        x = POINT[0];
        y = POINT[1];
        scale = 1 / scene.zoom;
      } else if (f.kind === "object") {
        const at = scene.objectPosition(f.index);
        x = at[0] + f.dx;
        y = at[1] + f.dy;
      } else if (f.kind === "player") {
        const p = scene.playerPosition(f.which);
        if (p) {
          x = p.x;
          y = p.y;
        }
      }
      const state = waveState(w.spec, w.elapsed, STATE);
      const alpha = waveAlpha(state.opacity, w.spec.opacityMod);
      if (alpha === 0 || !(state.radius > 0)) continue;
      const radius = state.radius * scale;
      const half = (w.spec.lineWidth * scene.unitsPerPixel) / 2;
      const reach = radius + (w.spec.outline ? half : 0);
      const view = scene.view;
      if (x + reach < view.x0 || x - reach > view.x1 || y + reach < view.y0 || y - reach > view.y1) continue;
      const from = this.count;
      // The sides go by the radius in the circle's own units.
      const sides = circleSegments(state.radius);
      if (w.spec.outline) this.ring(x, y, radius, sides, half, u, v, quad.unit, w.spec.colour, alpha);
      else this.disc(x, y, radius, sides, u, v, quad.unit, w.spec.colour, alpha);
      if (!game) this.counted(w.spec.z, from, this.count);
    }
    if (!game) this.gameFrom = this.count;
    return this.count;
  }

  /**
   * Where the last build's game-layer circles start in the buffer, and how
   * many instances they make: after every object-layer run, drawn by the
   * scene over the whole level.
   */
  get gameStart(): number {
    return this.gameFrom;
  }

  get gameCount(): number {
    return this.count - this.gameFrom;
  }

  /** ccDrawFilledCircle: the polygon as a fan of triangles from its first corner. */
  private disc(cx: number, cy: number, r: number, sides: number, u: number, v: number, unit: number, colour: Rgb, alpha: number): void {
    const step = (2 * Math.PI) / sides;
    const ax = cx + r;
    const ay = cy;
    let bx = cx + r * Math.cos(step);
    let by = cy + r * Math.sin(step);
    for (let i = 2; i < sides; i++) {
      const qx = cx + r * Math.cos(i * step);
      const qy = cy + r * Math.sin(i * step);
      this.triangle(ax, ay, bx, by, qx, qy, u, v, unit, colour, alpha);
      bx = qx;
      by = qy;
    }
  }

  /** ccDrawCircle under glLineWidth: each side a band `half` either side of it. */
  private ring(cx: number, cy: number, r: number, sides: number, half: number, u: number, v: number, unit: number, colour: Rgb, alpha: number): void {
    const step = (2 * Math.PI) / sides;
    let px = cx + r;
    let py = cy;
    for (let i = 1; i <= sides; i++) {
      const qx = cx + r * Math.cos(i * step);
      const qy = cy + r * Math.sin(i * step);
      this.band(px, py, qx, qy, half, u, v, unit, colour, alpha);
      px = qx;
      py = qy;
    }
  }

  private next(): number {
    const at = this.count;
    if ((at + 1) * INSTANCE_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.bytes = new Uint8Array(grown.buffer);
    }
    this.count = at + 1;
    return at;
  }

  /** The triangle a, b, c as one instance (SHAPE.TRIANGLE): pos (b + c) / 2, x (b − a) / 2, y (a − c) / 2. */
  private triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, u: number, v: number, unit: number, colour: Rgb, alpha: number): void {
    const at = this.next();
    const f = at * INSTANCE_FLOATS;
    const d = this.data;
    d[f] = (bx - ax) / 2;
    d[f + 1] = (by - ay) / 2;
    d[f + 2] = (ax - cx) / 2;
    d[f + 3] = (ay - cy) / 2;
    d[f + 4] = (bx + cx) / 2;
    d[f + 5] = (by + cy) / 2;
    this.finish(at, u, v, unit, colour, alpha, SHAPE.TRIANGLE);
  }

  /** The band from p to q, `half` either side, as one instance. */
  private band(px: number, py: number, qx: number, qy: number, half: number, u: number, v: number, unit: number, colour: Rgb, alpha: number): void {
    const len = Math.hypot(qx - px, qy - py);
    if (!(len > 0)) return;
    const at = this.next();
    const f = at * INSTANCE_FLOATS;
    const d = this.data;
    d[f] = (qx - px) / 2;
    d[f + 1] = (qy - py) / 2;
    d[f + 2] = (-(qy - py) / len) * half;
    d[f + 3] = ((qx - px) / len) * half;
    d[f + 4] = (px + qx) / 2;
    d[f + 5] = (py + qy) / 2;
    this.finish(at, u, v, unit, colour, alpha, SHAPE.QUAD);
  }

  /**
   * The rest of an instance: the one white texel, the colour, and ADD — a
   * flat colour drawn GL_SRC_ALPHA / GL_ONE, which the circle's +304 asks
   * for and every caller leaves set. [CCCircleWave::draw :59696-59697,
   *  :59775-59776]
   */
  private finish(at: number, u: number, v: number, unit: number, colour: Rgb, alpha: number, shape: number): void {
    const f = at * INSTANCE_FLOATS;
    const d = this.data;
    d[f + 6] = u;
    d[f + 7] = v;
    d[f + 8] = 0;
    d[f + 9] = 0;
    const o = at * INSTANCE_BYTES;
    const b = this.bytes;
    b[o + 40] = colour.r;
    b[o + 41] = colour.g;
    b[o + 42] = colour.b;
    b[o + 43] = alpha;
    b[o + 44] = unit;
    b[o + 45] = 0;
    b[o + 46] = BLEND.ADD;
    b[o + SHAPE_BYTE] = shape;
  }

  /** Files instances `from` to `to` under the run for z `z`. */
  private counted(z: number, from: number, to: number): void {
    if (to <= from) return;
    const last = this.runs - 1;
    if (last >= 0 && this.runZ[last] === z) {
      this.runCount[last] += to - from;
      return;
    }
    if (this.runs >= this.runZ.length) {
      const size = this.runZ.length * 2;
      const grow = <T extends Int16Array | Int32Array>(a: T, make: (n: number) => T): T => {
        const b = make(size);
        b.set(a);
        return b;
      };
      this.runZ = grow(this.runZ, (n) => new Int16Array(n));
      this.runStart = grow(this.runStart, (n) => new Int32Array(n));
      this.runCount = grow(this.runCount, (n) => new Int32Array(n));
    }
    const run = this.runs++;
    this.runZ[run] = z;
    this.runStart[run] = from;
    this.runCount[run] = to - from;
    const slot = slotOfZ(z);
    if (this.layerRuns[slot]++ === 0) this.layerRunFirst[slot] = run;
  }
}
