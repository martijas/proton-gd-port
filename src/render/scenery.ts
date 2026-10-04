// The background and the ground: the two flat images a level sits between.
//
// Both are single tiles repeated across the view. The background and the
// middleground stand on the screen rather than in the level: each step they
// move the other way from the camera by a share of its move, the background a
// tenth and the middleground three tenths across and half up, so they read as
// distance. The ground travels with the level.

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS, SHEET_BACKGROUND, SHEET_GROUND, SHEET_GROUND_DETAIL } from "../engine/gl/spriteBatch";
import { uploadTexture } from "../engine/gl/texture";
import type { Scenery } from "../assets/scenery";
import type { SceneryImage } from "../assets/miscTypes";
import type { LevelHeader } from "../level/types";
import type { Camera } from "./camera";
import { CHANNEL, type ColorTable, type ResolvedChannel } from "./colors";
import { VIEW_UNITS_HIGH, VIEW_UNITS_WIDE } from "../ui/viewport";

/**
 * How far the background and the middleground move across the screen for
 * each unit the camera's centre moves, at a zoom of 1: what every run starts
 * with. The BG Speed and MG Speed triggers (3606, 3612) change them, which
 * this port does not run yet.
 * [gdp GJBaseGameLayer::resetLevelVariables :462922-462923 →
 *  updateBGArtSpeed(0.1, 0.1) :430921-430943, updateMGArtSpeed(0.3, 0.5)
 *  :430959-430972]
 */
export const BACKGROUND_SPEED = { x: 0.1, y: 0.1 } as const;
export const MIDDLEGROUND_SPEED = { x: 0.3, y: 0.5 } as const;
/** The floor the ground hangs from; the simulation's floor is the same line. */
export const FLOOR_Y = 0;
/**
 * The middleground's own height on the screen, before the zoom moves it: the
 * game takes it from a table the decompile does not have
 * (GJMGLayer::defaultYOffsetForBG2 :382677-382686, off_9826A8), so its foot
 * is put on the floor line as the camera starts, where the art expects it.
 * [guess]
 */
const MIDDLEGROUND_BASE_Y = 90;
/** The game's y of the floor line. */
const GAME_FLOOR = 90;

/**
 * How the line and the middleground meet what is under them. Their channels'
 * blending is the only blend the game ever switches on its scenery, and it
 * sets GL_SRC_ALPHA / GL_ONE on premultiplied art whose colour cocos has
 * already multiplied by its opacity: a sprite in an additive batch, so the
 * line's soft ends and a faded middleground add a good deal less than their
 * colour times their alpha. The background and the ground have no such
 * switch and always cover: the background is even drawn GL_ONE / GL_ZERO.
 * [GJGroundLayer::createLine :382015-382055 (setBlendFunc(770, 1) on +333),
 *  updateLineBlend :382377-382392; GJMGLayer::updateMG01Blend
 *  :383263-383280, updateMG02Blend :383296ff (the batch node's blend, as
 *  setupLayers sets its own); GJBaseGameLayer::updateLevelColors
 *  :418679-418783 reads shouldBlend for 1002, 1013 and 1014 alone;
 *  createBackground :418127 (setBlendFunc(1, 0)); CCSprite::updateColor
 *  :863976-864005]
 */
function sceneryBlend(tint: ResolvedChannel): number {
  return tint.blending ? BLEND.ADD_SPRITE : BLEND.NORMAL;
}

/**
 * Where the background or the middleground has got to on the screen: the
 * foot of the background's first tile, or the middleground's first tile
 * across, in screen units. The game never puts either anywhere: the
 * background starts at the screen's bottom left when it is made, and both
 * then move each step by the camera's own move times their speed and the
 * zoom, the other way, wrapped across by a tile. So they remember where they
 * got to, a restart's jump back included: the step a reset makes moves
 * nothing. Only the background moves up and down this way; the
 * middleground's height is worked out afresh (buildMiddleground).
 * [gdp GJBaseGameLayer::updateCameraBGArt :431053-431113 (the camera's move
 *  +972, zeroed while +10949 says the layer is resetting; the background's
 *  wrap by its width +980), :431141-431165 (the middleground's);
 *  createBackground :418087-418140 (anchor 0,0, never positioned)]
 */
export class BackdropDrift {
  x = 0;
  y = 0;

  reset(): void {
    this.x = 0;
    this.y = 0;
  }

  /**
   * One step of the camera: its centre moved `dx`, `dy` at `zoom`. `wide`
   * is a tile's width on the screen, which x wraps by.
   */
  step(dx: number, dy: number, zoom: number, speedX: number, speedY: number, wide: number): void {
    this.x -= dx * speedX * zoom;
    this.y -= dy * speedY * zoom;
    if (wide > 0) {
      this.x %= wide;
      if (this.x > 0) this.x -= wide;
    }
  }
}

/**
 * How much the background is scaled up on the screen: by the larger of the
 * window's two scale factors against the 480 × 320 design, so it covers a
 * wide window. 1.185 at 16:9. [gdp createBackground :418123-418126 →
 *  AppDelegate::bgScale :77139-77145 (CCDirector::getScreenScaleFactorMax,
 *  updateScreenScale :801160-801170)]
 */
export function backgroundScale(designWide: number, designHigh: number): number {
  return Math.max(designWide / VIEW_UNITS_WIDE, designHigh / VIEW_UNITS_HIGH);
}

/**
 * The middleground's scale on the screen: 1.2 at a zoom of 1, shrinking by
 * three tenths of what the zoom does. [gdp updateCameraBGArt :431122-431129]
 */
export function middlegroundScale(zoom: number): number {
  return 1.2 * (1 - (1 - Math.abs(zoom)) * 0.3);
}

/**
 * Where the middleground's foot is on the screen, from the screen's bottom:
 * its base plus the MG trigger's offset, carried by half the zoom's change,
 * less half the camera's height in the level (`bottom`, the view's foot in
 * the game's y). [gdp updateCameraBGArt :431145 (v30, the not-editor branch)]
 */
export function middlegroundFoot(offsetY: number, zoom: number, bottom: number): number {
  const s = MIDDLEGROUND_SPEED.y;
  return (MIDDLEGROUND_BASE_Y + offsetY) * (1 - s + zoom * s) - bottom * s;
}

/**
 * The bright line along the top of the ground.
 *
 * `kA17` on the header picks it, and the game clamps the value into 1..3 —
 * which means every level has one, including the twenty that leave the key at
 * zero. Index 1 is a thin line, 2 and 3 a thicker one, and 3 draws it at twice
 * the height. It follows colour channel 1002, which is the channel the editor
 * calls "line" and which nothing else in the port was reading.
 * [gdp GJGroundLayer::createLine, gd-ida-decomp.cpp:381984-382056;
 *  the index reaches it through createGroundLayer :418286 from kA17]
 */
export interface GroundLine {
  u0: number;
  v0: number;
  du: number;
  dv: number;
  unit: number;
  /** Height in units, before the index-3 doubling. */
  height: number;
  rotated: boolean;
  scaleY: number;
}

/** Which frame a header's ground-line index asks for. */
export function groundLineFrame(index: number): string {
  return `floorLine_${index >= 2 ? "02" : "01"}_001.png`;
}

/** How tall the line is drawn, relative to its own art. */
export function groundLineScale(index: number): number {
  return index >= 3 ? 2 : 1;
}

/**
 * Whether a background repeats unflipped top to bottom where a turned view
 * reaches past it: the ones whose art tiles seamlessly. Every other one
 * repeats mirrored. [gdp GJBaseGameLayer::createBackground :418087-418113
 * (GL_REPEAT for 16, 35, 37, 40-51 and 53-59, GL_MIRRORED_REPEAT otherwise;
 * anything past 59 is 59)]
 */
export function backgroundRepeats(id: number): boolean {
  const n = Math.min(id, 59);
  return n === 16 || n === 35 || n === 37 || (n >= 40 && n <= 51) || (n >= 53 && n <= 59);
}

interface Tile {
  texture: WebGLTexture;
  unit: number;
  /** Tile size in GD units. */
  width: number;
  height: number;
}

export interface Backdrop {
  /** One tile's size in the level's units. */
  width: number;
  height: number;
  /** The bottom left of the tile the drift places, in the level's units. */
  x: number;
  y: number;
}

/**
 * The background's placed tile in the level's units: the drift's place on
 * the screen (in screen units) taken through the view at `zoom`, the tile
 * `scale` times its own size on the screen. The rows and columns either
 * side of it repeat. `left` and `bottom` are the view's, unturned.
 */
export function backdropPlacement(
  tileWidth: number,
  tileHeight: number,
  left: number,
  bottom: number,
  zoom: number,
  scale: number,
  drift: { x: number; y: number },
): Backdrop {
  return {
    width: (tileWidth * scale) / zoom,
    height: (tileHeight * scale) / zoom,
    x: left + drift.x / zoom,
    y: bottom + drift.y / zoom,
  };
}

export class SceneryRenderer {
  private line: GroundLine | null = null;
  private background: Tile | null = null;
  /** Whether the background's rows past the placed one are drawn mirrored. */
  private backgroundMirrors = true;
  /**
   * The middleground's two images. They share one texture unit and are drawn
   * as two passes rather than two units, because the budget is sixteen and all
   * sixteen are already spoken for. One level uses this: Dash.
   */
  private middleground: { base: WebGLTexture; detail: WebGLTexture | null; unit: number; width: number; height: number; detailHeight: number } | null = null;
  private ground: Tile | null = null;
  private groundDetail: Tile | null = null;
  private scratch = new Float32Array(256 * INSTANCE_FLOATS);
  private bytes = new Uint8Array(this.scratch.buffer);
  count = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** Uploads the three images this level needs. Cheap: they are one PNG each. */
  async setLevel(scenery: Scenery, header: LevelHeader): Promise<(WebGLTexture | null)[]> {
    const ppu = scenery.pxPerUnit;
    const make = async (entry: SceneryImage | undefined, unit: number): Promise<Tile | null> => {
      if (!entry) return null;
      const image = await scenery.image(entry);
      return {
        texture: uploadTexture(this.gl, image, { wrap: this.gl.REPEAT }),
        unit,
        width: entry.w / ppu,
        height: entry.h / ppu,
      };
    };
    const bg = scenery.background(header.background);
    const gnd = scenery.ground(header.ground);
    this.background = await make(bg, SHEET_BACKGROUND);
    this.backgroundMirrors = !backgroundRepeats(header.background);
    this.ground = await make(gnd?.base, SHEET_GROUND);
    this.groundDetail = await make(gnd?.detail, SHEET_GROUND_DETAIL);
    const out: (WebGLTexture | null)[] = [];
    out[SHEET_BACKGROUND] = this.background?.texture ?? null;
    out[SHEET_GROUND] = this.ground?.texture ?? null;
    out[SHEET_GROUND_DETAIL] = this.groundDetail?.texture ?? null;
    return out;
  }

  /**
   * Uploads the middleground a level asks for, if any. `kA25` on the header
   * picks it, and only Dash sets it in the official set.
   * [gdp GameManager::loadMiddleground, gd-ida-decomp.cpp:111704, whose images
   *  are fg_%02d_001.png and fg_%02d_2_001.png; the index reaches it from
   *  LevelSettingsObject+304, which kA17's neighbour kA25 writes :196207]
   */
  async setMiddleground(scenery: Scenery, index: number, unit: number): Promise<void> {
    this.middleground = null;
    if (!(index >= 1)) return;
    const entry = scenery.foreground(index);
    if (!entry) return;
    const ppu = scenery.pxPerUnit;
    const base = uploadTexture(this.gl, await scenery.image(entry.base), { wrap: this.gl.REPEAT });
    const detail = entry.detail ? uploadTexture(this.gl, await scenery.image(entry.detail), { wrap: this.gl.REPEAT }) : null;
    this.middleground = {
      base,
      detail,
      unit,
      width: entry.base.w / ppu,
      height: entry.base.h / ppu,
      detailHeight: (entry.detail?.h ?? entry.base.h) / ppu,
    };
  }

  /** The middleground's textures, in the order they are drawn. */
  get middlegroundPasses(): Array<{ texture: WebGLTexture; detail: boolean }> {
    const mg = this.middleground;
    if (!mg) return [];
    const out = [{ texture: mg.base, detail: false }];
    if (mg.detail) out.push({ texture: mg.detail, detail: true });
    return out;
  }

  /** The middleground's tile width on the screen at `zoom`, which its drift wraps by; 0 with none. */
  middlegroundWidth(zoom: number): number {
    return this.middleground ? this.middleground.width * middlegroundScale(zoom) : 0;
  }

  /**
   * One pass of the middleground: a row of tiles standing on the screen,
   * scaled with the zoom, moved across by `drift` and placed up by
   * middlegroundFoot with the MG trigger's `offsetY`. These are the
   * silhouettes along the bottom of the screen, not a second sky.
   * `alpha` is the frame's place between ticks.
   */
  buildMiddleground(camera: Camera, colors: ColorTable, detail: boolean, drift: BackdropDrift, offsetY: number, alpha = 1): number {
    const mg = this.middleground;
    this.count = 0;
    if (!mg) return 0;
    const zoom = camera.zoomAt(alpha);
    const view = camera.coverBounds(0, alpha);
    const centre = camera.centre(alpha);
    const left = centre.x - camera.unitsWideAt(alpha) / 2;
    const bottom = centre.y - camera.unitsHighAt(alpha) / 2;
    const scale = middlegroundScale(zoom) / zoom;
    const width = mg.width * scale;
    const height = (detail ? mg.detailHeight : mg.height) * scale;
    const x = left + drift.x / zoom;
    const foot = bottom + middlegroundFoot(offsetY, zoom, bottom + GAME_FLOOR) / zoom;
    const first = Math.floor((view.x0 - x) / width);
    const last = Math.ceil((view.x1 - x) / width);
    const tint = colors.get(detail ? CHANNEL.MIDDLEGROUND_2 : CHANNEL.MIDDLEGROUND);
    this.ensure(last - first + 2);
    let at = 0;
    for (let col = first; col <= last; col++) {
      this.write(at++, x + (col + 0.5) * width, foot + height / 2, width / 2, height / 2, mg.unit, tint, sceneryBlend(tint));
    }
    this.count = at;
    return at;
  }

  /** The ground line this level draws, or null when the art is missing. */
  setLine(line: GroundLine | null): void {
    this.line = line;
  }

  /**
   * One stretched strip of the line art, along `y`. `up` is which way the
   * ground it belongs to grows, so the ceiling's copy hangs the other way.
   */
  private writeLine(at: number, view: { x0: number; x1: number }, y: number, up: boolean, tint: ResolvedChannel): number {
    const line = this.line;
    if (!line) return at;
    const height = line.height * line.scaleY;
    const f = at * INSTANCE_FLOATS;
    const s = this.scratch;
    s[f] = (view.x1 - view.x0) / 2 + 2;
    s[f + 1] = 0;
    s[f + 2] = 0;
    s[f + 3] = up ? height / 2 : -height / 2;
    s[f + 4] = (view.x0 + view.x1) / 2;
    // The art hangs from the line rather than straddling it, which is what puts
    // the bright edge on the ground instead of in the air above it.
    s[f + 5] = up ? y - height / 2 : y + height / 2;
    s[f + 6] = line.u0;
    s[f + 7] = line.v0;
    s[f + 8] = line.du;
    s[f + 9] = line.dv;
    const o = at * INSTANCE_BYTES;
    this.bytes[o + 40] = tint.r;
    this.bytes[o + 41] = tint.g;
    this.bytes[o + 42] = tint.b;
    this.bytes[o + 43] = Math.round(tint.a * 255);
    this.bytes[o + 44] = line.unit;
    this.bytes[o + 45] = line.rotated ? 1 : 0;
    this.bytes[o + 46] = sceneryBlend(tint);
    this.bytes[o + 47] = 0;
    return at + 1;
  }

  private write(
    at: number,
    cx: number,
    cy: number,
    hw: number,
    hh: number,
    unit: number,
    tint: ResolvedChannel,
    blend: number,
  ): void {
    const f = at * INSTANCE_FLOATS;
    const s = this.scratch;
    s[f] = hw;
    s[f + 1] = 0;
    s[f + 2] = 0;
    s[f + 3] = hh;
    s[f + 4] = cx;
    s[f + 5] = cy;
    s[f + 6] = 0;
    s[f + 7] = 0;
    s[f + 8] = 1;
    s[f + 9] = 1;
    const o = at * INSTANCE_BYTES;
    this.bytes[o + 40] = tint.r;
    this.bytes[o + 41] = tint.g;
    this.bytes[o + 42] = tint.b;
    this.bytes[o + 43] = Math.round(tint.a * 255);
    this.bytes[o + 44] = unit;
    this.bytes[o + 45] = 0;
    this.bytes[o + 46] = blend;
    this.bytes[o + 47] = 0;
  }

  private ensure(needed: number): void {
    if (needed * INSTANCE_FLOATS <= this.scratch.length) return;
    this.scratch = new Float32Array(needed * INSTANCE_FLOATS * 2);
    this.bytes = new Uint8Array(this.scratch.buffer);
  }

  /** The background's tile width on the screen for this window, which its drift wraps by; 0 with none. */
  backgroundWidth(camera: Camera): number {
    const tile = this.background;
    if (!tile) return 0;
    const zoom = camera.zoomAt(1);
    return tile.width * backgroundScale(camera.unitsWideAt(1) * zoom, camera.unitsHighAt(1) * zoom);
  }

  /**
   * The backdrop: the image, scaled up to the window (backgroundScale) and
   * standing on the screen where `drift` has taken it, repeated across. It
   * starts with its foot at the screen's foot, so a level opens on the
   * bottom of the art, and climbing a tenth as fast as the camera does.
   *
   * Above and below the placed row the game's texture repeats, so this adds
   * rows there, mirrored top to bottom unless the background is one of those
   * that tile seamlessly (backgroundRepeats). [gdp GJBaseGameLayer::visit
   * :433826-433875; createBackground :418087-418140]
   */
  buildBackground(camera: Camera, colors: ColorTable, drift: BackdropDrift, alpha = 1): number {
    const tile = this.background;
    this.count = 0;
    if (!tile) return 0;
    const zoom = camera.zoomAt(alpha);
    const high = camera.unitsHighAt(alpha);
    const wide = camera.unitsWideAt(alpha);
    const view = camera.coverBounds(0, alpha);
    const centre = camera.centre(alpha);
    const scale = backgroundScale(wide * zoom, high * zoom);
    const place = backdropPlacement(tile.width, tile.height, centre.x - wide / 2, centre.y - high / 2, zoom, scale, drift);
    const first = Math.floor((view.x0 - place.x) / place.width);
    const last = Math.ceil((view.x1 - place.x) / place.width);
    const below = Math.max(0, Math.ceil((place.y - view.y0) / place.height));
    const above = Math.max(0, Math.ceil((view.y1 - place.y - place.height) / place.height));
    const tint = colors.get(CHANNEL.BG);
    this.ensure((last - first + 2) * (below + above + 1));
    let at = 0;
    for (let row = -below; row <= above; row++) {
      const flip = this.backgroundMirrors && row % 2 !== 0;
      const y = place.y + (row + 0.5) * place.height;
      for (let col = first; col <= last; col++) {
        this.write(at++, place.x + (col + 0.5) * place.width, y, place.width / 2, flip ? -place.height / 2 : place.height / 2, tile.unit, tint, BLEND.NORMAL);
      }
    }
    this.count = at;
    return at;
  }

  /**
   * Ground tiles, hanging from the floor line and travelling with the level.
   *
   * `floorY` is the play area's floor, not the level's: a flying corridor can
   * sit well above the ground — 57 of the 113 corridor portals in the official
   * levels lift it — and the art has to be where the player actually lands or
   * it appears to be standing on nothing. A turned view gets the columns and
   * rows its corners reach. [gdp GJBaseGameLayer::preUpdateVisibility
   * :452627-452638; updateCameraBGArt :431165-431214]
   */
  buildGround(camera: Camera, colors: ColorTable, floorY = FLOOR_Y, alpha = 1): number {
    const tile = this.ground;
    this.count = 0;
    if (!tile) return 0;
    const view = camera.coverBounds(0, alpha);
    const first = Math.floor(view.x0 / tile.width);
    const last = Math.ceil(view.x1 / tile.width);
    // Enough rows to reach the bottom of the view, however far the camera sinks.
    const depth = Math.max(1, Math.ceil((floorY - view.y0) / tile.height));
    const base = colors.get(CHANNEL.GROUND);
    const detailTint = colors.get(CHANNEL.GROUND_2);
    this.ensure((last - first + 1) * (depth + 1) + 8);
    let at = 0;
    for (let row = 0; row < depth; row++) {
      for (let col = first; col <= last; col++) {
        this.write(
          at++,
          (col + 0.5) * tile.width,
          floorY - (row + 0.5) * tile.height,
          tile.width / 2,
          tile.height / 2,
          tile.unit,
          base,
          BLEND.NORMAL,
        );
      }
    }
    // The second image, where the ground has one, sits on top of the first.
    if (this.groundDetail) {
      const detail = this.groundDetail;
      for (let col = first; col <= last; col++) {
        this.write(
          at++,
          (col + 0.5) * detail.width,
          floorY - detail.height / 2,
          detail.width / 2,
          detail.height / 2,
          detail.unit,
          detailTint,
          BLEND.NORMAL,
        );
      }
    }
    at = this.writeLine(at, view, floorY, true, colors.get(CHANNEL.LINE));
    this.count = at;
    return at;
  }

  /**
   * The ceiling of a flying corridor: the same ground art, mirrored, growing
   * upward from the corridor's top.
   *
   * Only the grounded modes see open sky. Ship, UFO, wave and swing are inside
   * a corridor with a real ceiling the player collides with, and the game draws
   * it out of the ground tiles turned over — without it a ship section is a
   * black gap the player bumps into for no visible reason, which is exactly
   * what Stereo Madness's ship part and Blast Processing's wave part looked
   * like.
   *
   * Mirroring is a negative half-height: the shader takes the texture
   * coordinate from the corner index and the geometry from the transform, so
   * flipping one leaves the other alone.
   */
  buildCeiling(camera: Camera, colors: ColorTable, ceilingY: number, alpha = 1): number {
    const tile = this.ground;
    this.count = 0;
    if (!tile || !Number.isFinite(ceilingY)) return 0;
    const view = camera.coverBounds(0, alpha);
    // Nothing to draw when the corridor's top is above the view.
    if (ceilingY > view.y1) return 0;
    const first = Math.floor(view.x0 / tile.width);
    const last = Math.ceil(view.x1 / tile.width);
    const height = Math.max(1, Math.ceil((view.y1 - ceilingY) / tile.height));
    const base = colors.get(CHANNEL.GROUND);
    const detailTint = colors.get(CHANNEL.GROUND_2);
    this.ensure((last - first + 1) * (height + 1) + 8);
    let at = 0;
    for (let row = 0; row < height; row++) {
      for (let col = first; col <= last; col++) {
        this.write(
          at++,
          (col + 0.5) * tile.width,
          ceilingY + (row + 0.5) * tile.height,
          tile.width / 2,
          -tile.height / 2,
          tile.unit,
          base,
          BLEND.NORMAL,
        );
      }
    }
    if (this.groundDetail) {
      const detail = this.groundDetail;
      for (let col = first; col <= last; col++) {
        this.write(
          at++,
          (col + 0.5) * detail.width,
          ceilingY + detail.height / 2,
          detail.width / 2,
          -detail.height / 2,
          detail.unit,
          detailTint,
          BLEND.NORMAL,
        );
      }
    }
    at = this.writeLine(at, view, ceilingY, false, colors.get(CHANNEL.LINE));
    this.count = at;
    return at;
  }

  get data(): Float32Array {
    return this.scratch;
  }
}
