// Drawing a player icon in a menu.
//
// An icon is a stack of layers at one origin — the shape, the second colour,
// a fixed-colour detail and an outline behind it all — each on one of the
// icon pages, which are bound to texture units on demand the same way the
// level binds them for the player. The interface asks for an `icon` widget;
// this turns it into the sprites on the interface's own batch.
//
// The robot and the spider are limbs rather than one sprite. Their kit
// picture is the resting pose, laid out by the same animation frame the
// player uses, so the picker shows what the level will.

import { animFrame, partOf, type AnimEntity } from "../assets/anims";
import type { IconSet } from "../assets/icons";
import { ICON_LAYER_ORDER, type IconKind, type IconLayer } from "../assets/iconTypes";
import { affine, apply, compose, type Affine } from "../engine/math";
import { frameQuad } from "../render/frameQuad";
import { VEHICLES } from "../render/player";
import type { UiBatch, Tint, UiQuad } from "./draw";
import type { Widget } from "./widgets";

export type IconWidget = Extract<Widget, { kind: "icon" }>;

/** What drawing an icon needs from the rest of the game. */
export interface IconArt {
  icons: IconSet;
  /** Which unit an icon page is bound to right now, or undefined when it is not. */
  unitOf(page: number): number | undefined;
  /** The game's colour table, by the index the save stores. */
  colour(index: number): { r: number; g: number; b: number };
  /** The resting pose for a skeletal kind, when its animation is loaded. */
  entity(kind: IconKind): AnimEntity | undefined;
}

const WHITE_TINT: Tint = { r: 255, g: 255, b: 255 };

/** Which clip a kit picture stands in. */
const REST_CLIP: Partial<Record<IconKind, string>> = { robot: "idle01", spider: "idle01" };

/**
 * Draws one icon widget. Layers whose page is not bound are skipped rather
 * than drawn from the wrong page; the screen that placed the widget is
 * expected to have asked for the pages first.
 */
export function drawIcon(w: IconWidget, out: UiBatch, art: IconArt): void {
  const scale = w.scale ?? 1;
  const body = affine(w.x, w.y, w.rotation ?? 0, scale, w.flipY ? -scale : scale);
  if (w.rider !== undefined && (w.iconKind === "ship" || w.iconKind === "ufo")) {
    const vehicle = VEHICLES[w.iconKind];
    if (vehicle?.rider) {
      const r = vehicle.rider;
      drawLayers(w, compose(body, affine(0, vehicle.y, 0, 1, 1)), out, art);
      drawLayers({ ...w, iconKind: "cube", iconId: w.rider }, compose(body, affine(r.x, r.y, 0, r.scale, r.scale)), out, art);
      return;
    }
  }
  drawLayers(w, body, out, art);
}

function drawLayers(w: IconWidget, body: Affine, out: UiBatch, art: IconArt): void {
  const icon = art.icons.icon(w.iconKind, w.iconId);
  if (!icon) return;
  const dark = w.darken;
  const c1 = dark ?? art.colour(w.colour1);
  const c2 = dark ?? art.colour(w.colour2);
  const skip = (role: string): boolean => (role === "glow" && (!w.glow || !!dark)) || (role === "secondary" && !!dark);
  const entity = art.entity(w.iconKind);
  const clip = entity && w.clip && entity.animations[w.clip] ? w.clip : REST_CLIP[w.iconKind];
  const anim = entity && clip ? entity.animations[clip] : undefined;
  const step = anim && anim.delay > 0 && w.clipSeconds ? Math.floor(w.clipSeconds / anim.delay) : 0;
  const parts = entity && clip ? animFrame(entity, clip, step) : undefined;

  if (parts) {
    // A skeleton: every limb where the resting frame puts it.
    const ordered = [...parts].sort((a, b) => a.z - b.z);
    for (const part of ordered) {
      const local = compose(body, affine(part.x, part.y, part.rot, part.sx, part.sy));
      const number = partOf(part.tex);
      for (const role of ICON_LAYER_ORDER) {
        if (skip(role)) continue;
        for (const layer of icon.layers) {
          if (layer.role !== role || layer.part !== number) continue;
          push(layer, local, out, art, c1, c2, w.alpha, dark);
        }
      }
    }
    return;
  }

  for (const role of ICON_LAYER_ORDER) {
    if (skip(role)) continue;
    for (const layer of icon.layers) {
      if (layer.role !== role) continue;
      // Without a pose, a skeleton's first part is its body, and the body on
      // its own is still recognisably the icon.
      if (layer.part !== undefined && layer.part !== 1) continue;
      push(layer, body, out, art, c1, c2, w.alpha, dark);
    }
  }
}

function push(
  layer: IconLayer,
  matrix: Affine,
  out: UiBatch,
  art: IconArt,
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  alpha: number | undefined,
  dark?: Tint,
): void {
  const found = art.icons.frame(layer.n);
  if (!found) return;
  const unit = art.unitOf(found.page);
  if (unit === undefined) return;
  const q = frameQuad(found.atlas, found.frame, art.icons.pxPerUnit);
  const quad: UiQuad = { u0: q.u0, v0: q.v0, du: q.du, dv: q.dv, unit, w: q.hw * 2, h: q.hh * 2, rotated: q.rotated };
  // The shape follows colour 1, the second layer and the outline colour 2,
  // and the fixed detail and the UFO's canopy are drawn as painted.
  const tint: Tint = dark ?? (layer.role === "base" ? c1 : layer.role === "secondary" || layer.role === "glow" ? c2 : WHITE_TINT);
  const centre = apply(matrix, q.cx, q.cy);
  // The matrix carries scale and, for a limb, rotation; the quad's own size
  // comes through it too.
  const sx = Math.hypot(matrix.a, matrix.b);
  const sy = Math.hypot(matrix.c, matrix.d) * (matrix.a * matrix.d - matrix.b * matrix.c < 0 ? -1 : 1);
  const rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
  out.sprite(quad, centre.x, centre.y, { scaleX: sx, scaleY: sy, rotation, tint, alpha });
}
