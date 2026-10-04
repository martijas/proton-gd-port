// Drawing a screen's widgets.
//
// The only part of the interface that touches GL. It owns the packed page's
// texture, the font pages and the main menu's backdrop tiles, binds them to
// the units reserved for them, and writes everything into one UiBatch — so a
// whole menu, text and all, is one more draw call on the batch the level is
// already using.
//
// Drawn *after* the level's screen-effect band has been laid down, which is
// what keeps a shader trigger from warping the pause menu.

import type { IconSet } from "../assets/icons";
import type { GlContext } from "../engine/gl/context";
import { SHEET_BACKGROUND, SHEET_GROUND, SHEET_UI, type SpriteBatch } from "../engine/gl/spriteBatch";
import { uploadTexture } from "../engine/gl/texture";
import { assetUrl } from "../assets/paths";
import { assignFontUnits, FRAMES, insetsFor, PRESS_SCALE, type FontName, type UiArt } from "./art";
import { UiBatch, WHITE, type Tint, type UiQuad } from "./draw";
import { layout, measure, type TextOptions } from "./text";
import type { LevelFont } from "../render/text";
import { effectArtFrom, type EffectArt } from "../render/effects";
import type { Rect, UiViewport } from "./viewport";
import { barFill, flatten, listMetrics, rowRect, shifted, type Widget } from "./widgets";

/** A self-filling bar's black backing, and how tall its fill is against it. [gdp LevelPage::init :338814, :338824] */
const BAR_BACK_ALPHA = 125 / 255;
const BAR_FILL_HEIGHT = 0.86;

function decode(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${path} could not be loaded`));
    img.src = assetUrl(path);
  });
}

/** Colours the game uses that are not in a sprite. [meas] */
export const UI_COLOURS = {
  text: { r: 255, g: 255, b: 255 } as Tint,
  dim: { r: 170, g: 170, b: 190 } as Tint,
  gold: { r: 255, g: 212, b: 64 } as Tint,
  shade: { r: 0, g: 0, b: 0 } as Tint,
  disabled: { r: 120, g: 120, b: 130 } as Tint,
  /** The fill of a normal-mode bar, and of the level's own bar. */
  barNormal: { r: 0, g: 255, b: 0 } as Tint,
  /** The fill of a practice-mode bar. */
  barPractice: { r: 0, g: 255, b: 255 } as Tint,
  /** The blue every menu but the first is washed in. */
  menuBlue: { r: 0, g: 102, b: 255 } as Tint,
};

/** How far the menu's sky drifts for each unit the ground does. [gdp MenuGameLayer::update] */
export const MENU_SKY_PARALLAX = 0.1;

/** A backdrop tile as uploaded: its texture and its size in units. */
interface MenuTile {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export class UiRenderer {
  private readonly batch = new UiBatch();
  private pageTexture: WebGLTexture | null = null;
  private readonly fontTextures = new Map<FontName, WebGLTexture>();
  /** Which unit each loaded font draws from; settled at load and never juggled. */
  private fontUnits = new Map<FontName, number>();
  private sky: MenuTile | null = null;
  private ground: MenuTile | null = null;
  /** Names that resolved to nothing, reported once each rather than every frame. */
  private readonly missing = new Set<string>();

  constructor(
    private readonly gl: GlContext,
    readonly art: UiArt,
  ) {}

  /** Uploads the packed page, the fonts the interface starts with and the backdrop. */
  async load(fonts: readonly FontName[] = ["bigFont", "goldFont", "chatFont"]): Promise<void> {
    const gl = this.gl.gl;
    this.pageTexture = uploadTexture(gl, await decode(this.art.pageImage));
    // A packed face draws off the page and takes no unit.
    this.fontUnits = assignFontUnits(fonts.filter((f) => !this.art.isPacked(f)));
    for (const name of this.fontUnits.keys()) {
      const image = this.art.fontImage(name);
      if (!image) continue;
      const texture = uploadTexture(gl, await decode(image));
      if (texture) this.fontTextures.set(name, texture);
    }
    const menu = this.art.menu;
    if (menu) {
      const tile = async (entry: typeof menu.background): Promise<MenuTile> => ({
        texture: uploadTexture(gl, await decode(entry.image), { wrap: gl.REPEAT }),
        width: entry.w / entry.pxPerUnit,
        height: entry.h / entry.pxPerUnit,
      });
      this.sky = await tile(menu.background);
      this.ground = await tile(menu.ground);
    }
  }

  /**
   * Binds the interface's own units and draws `widgets`.
   *
   * `icons` is an optional hook for a widget kind this module cannot draw on
   * its own — the player icon, which the renderer's own PlayerRenderer builds —
   * so the icon kit does not have to reach into GL itself. `heldId` is the
   * button under the pointer right now, whose face is drawn swollen.
   */
  draw(
    batch: SpriteBatch,
    view: UiViewport,
    widgets: readonly Widget[],
    icons?: (w: Extract<Widget, { kind: "icon" }>, out: UiBatch) => void,
    heldId: string | null = null,
  ): void {
    const gl = this.gl.gl;
    // Bound every frame, never remembered. The last unit is shared with the
    // level's middleground, the screen-effect band and every texture upload,
    // and an upload empties whatever unit it used — so a binding from last
    // frame may be gone, and believing otherwise is what drew glyphs as black
    // boxes. Four bind calls a frame is nothing next to being wrong.
    if (this.pageTexture) {
      gl.activeTexture(gl.TEXTURE0 + SHEET_UI);
      gl.bindTexture(gl.TEXTURE_2D, this.pageTexture);
    }
    for (const [name, unit] of this.fontUnits) {
      const texture = this.fontTextures.get(name);
      if (!texture) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }

    // The interface owns the whole screen, so its camera is the design box
    // centred on itself rather than wherever the level's camera is.
    batch.beginFrame(view.width / 2, view.height / 2, view.width, view.height);
    this.batch.begin();
    for (const widget of widgets) {
      if (widget.kind !== "list") {
        this.emit(widget, view, icons, heldId);
        continue;
      }
      // A list's rows are clipped to its box, which means their own draw
      // call under a scissor: whatever came before goes out first, then the
      // rows, then the rest. A list is a few draw calls; a row drawn past the
      // edge of its window was the alternative.
      this.flush(batch);
      const m = listMetrics(widget);
      for (let i = m.firstVisible; i <= m.lastVisible; i++) {
        const box = rowRect(widget, i);
        for (const child of widget.rows[i] ?? []) this.emit(shifted(child, box.x, box.y), view, icons, heldId);
      }
      this.flush(batch, widget.rect, view);
    }
    this.flush(batch);
  }

  /** Draws what the batch holds, inside `clip` when one is given, and starts it again. */
  private flush(batch: SpriteBatch, clip?: Rect, view?: UiViewport): void {
    if (this.batch.count > 0) {
      const gl = this.gl.gl;
      if (clip && view) {
        const sx = gl.drawingBufferWidth / view.width;
        const sy = gl.drawingBufferHeight / view.height;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(Math.floor(clip.x * sx), Math.floor(clip.y * sy), Math.ceil(clip.w * sx), Math.ceil(clip.h * sy));
        batch.draw(this.batch.buffer, this.batch.count);
        gl.disable(gl.SCISSOR_TEST);
      } else {
        batch.draw(this.batch.buffer, this.batch.count);
      }
    }
    this.batch.begin();
  }

  /**
   * What the level renderer needs to draw a text object in this face: the
   * metrics, the unit the page is on, and the page itself. The level and the
   * interface share one upload — they want the same face on the same unit, so
   * a second copy would cost a texture unit the budget does not have.
   */
  levelFont(name: FontName): { levelFont: LevelFont; texture: WebGLTexture } | null {
    const font = this.art.font(name);
    const unit = this.fontUnits.get(name);
    const texture = this.fontTextures.get(name);
    if (!font || unit === undefined || !texture) return null;
    return { levelFont: { font, pxPerUnit: this.art.fontPxPerUnit, unit }, texture };
  }

  /**
   * The packed page, as the level renderer sees it. The interface owns the one
   * upload; the level binds the same texture on the same unit for its trail
   * and its other loose art.
   */
  levelArt(): { art: EffectArt; texture: WebGLTexture } | null {
    if (!this.pageTexture) return null;
    return { art: effectArtFrom(this.art.page, SHEET_UI), texture: this.pageTexture };
  }

  /** Every frame name a screen asked for that does not exist. */
  get unresolved(): readonly string[] {
    return [...this.missing];
  }

  private quad(name: string): UiQuad | null {
    const q = this.art.quad(name);
    if (!q) this.missing.add(name);
    return q;
  }

  private emit(w: Widget, view: UiViewport, icons: ((w: Extract<Widget, { kind: "icon" }>, out: UiBatch) => void) | undefined, heldId: string | null): void {
    switch (w.kind) {
      case "panel": {
        const frame = w.frame ?? FRAMES.panel;
        const q = this.quad(frame);
        if (q) this.batch.nineSlice(q, w.rect, insetsFor(frame), w.tint ?? WHITE, w.alpha ?? 1);
        return;
      }
      case "fill": {
        const q = this.quad(w.frame ?? FRAMES.white);
        if (q) this.batch.stretched(q, w.rect, w.tint ?? WHITE, w.alpha ?? 1);
        return;
      }
      case "sprite": {
        const q = this.quad(w.frame);
        if (!q) return;
        const held = w.pressedBy !== undefined && w.pressedBy === heldId;
        const scale = (w.scale ?? 1) * (held ? PRESS_SCALE : 1);
        this.batch.sprite(q, w.x, w.y, {
          scaleX: w.flipX ? -scale : scale,
          scaleY: (w.flipY ? -scale : scale) * (w.scaleY ?? 1),
          rotation: w.rotation,
          tint: w.tint,
          alpha: w.alpha,
          originX: w.originX,
          originY: w.originY,
        });
        return;
      }
      case "text":
        this.text(w.text, w.x, w.y, w);
        return;
      case "button": {
        const frame = w.frame ?? FRAMES.button;
        const q = this.quad(frame);
        const enabled = w.enabled !== false;
        const tint = w.tint ?? (enabled ? WHITE : UI_COLOURS.disabled);
        // A held button grows about its centre, the way every button in the
        // game does; an invisible one has nothing to grow.
        const rect = w.id === heldId && (tint.a ?? 1) > 0 ? grown(w.rect, PRESS_SCALE) : w.rect;
        if (q) this.batch.nineSlice(q, rect, insetsFor(frame), tint, 1);
        if (w.label) {
          const off = w.labelOffset;
          const box = off ? { x: rect.x + off.x, y: rect.y + off.y, w: rect.w, h: rect.h } : rect;
          this.centredLabel(w.label, box, enabled ? (w.label.tint ?? UI_COLOURS.text) : UI_COLOURS.disabled);
        }
        return;
      }
      case "toggle": {
        const q = this.quad(w.on ? FRAMES.checkOn : FRAMES.checkOff);
        if (q) this.batch.stretched(q, w.rect, w.enabled === false ? UI_COLOURS.disabled : WHITE);
        if (w.label) {
          // The label sits to the right of the box rather than inside it.
          const box = { x: w.rect.x + w.rect.w + 8, y: w.rect.y, w: 400, h: w.rect.h };
          this.leftLabel(w.label, box, w.label.tint ?? UI_COLOURS.text);
        }
        return;
      }
      case "slider": {
        const groove = this.quad(FRAMES.sliderGroove);
        if (groove) this.batch.stretched(groove, w.rect);
        const thumb = this.quad(FRAMES.sliderThumb);
        if (thumb) {
          const value = Math.max(0, Math.min(1, w.value));
          this.batch.sprite(thumb, w.rect.x + value * w.rect.w, w.rect.y + w.rect.h / 2, { scale: w.scale ?? 0.5 });
        }
        return;
      }
      case "progress": {
        const q = this.quad(w.frame);
        if (!q) return;
        const s = w.scale ?? 1;
        const width = q.w * s;
        const height = q.h * s;
        const left = w.x - width / 2;
        const bottom = w.y - height / 2;
        // A groove is drawn as it is; a bar that fills with itself sits on a
        // black copy at 125. [gdp LevelPage::init :338812-338814]
        if (w.fillFrame) this.batch.sprite(q, w.x, w.y, { scale: s, alpha: w.alpha });
        else this.batch.sprite(q, w.x, w.y, { scale: s, alpha: (w.alpha ?? 1) * BAR_BACK_ALPHA, tint: { r: 0, g: 0, b: 0 } });
        const value = Math.max(0, Math.min(1, w.value));
        if (value <= 0) return;
        if (w.fillFrame) {
          const fill = this.quad(w.fillFrame);
          const inset = w.fillInset ?? { x: 0, y: 0 };
          const box: Rect = {
            x: left + inset.x * s,
            y: bottom + inset.y * s,
            w: (q.w - inset.x * 2) * s * value,
            h: (q.h - inset.y * 2) * s,
          };
          if (fill) this.batch.stretched(fill, box, w.fill, w.alpha ?? 1);
          return;
        }
        // The bar's own picture, cropped: that is what gives the fill the
        // bar's rounded left end.
        const span = barFill(value);
        const piece = this.batch.subQuad(q, span.from, 0, span.to, 1);
        const fillH = height * BAR_FILL_HEIGHT;
        this.batch.stretched(piece, { x: left + span.from * width, y: w.y - fillH / 2, w: (span.to - span.from) * width, h: fillH }, w.fill, w.alpha ?? 1);
        return;
      }
      case "backdrop":
        this.backdrop(w, view);
        return;
      case "icon":
        icons?.(w, this.batch);
        return;
      case "list":
        // Rows are drawn by `draw`, under the list's own clip; the list itself draws nothing.
        return;
    }
  }

  /**
   * The menu's sky and ground: two repeating tiles on the two scenery units,
   * which nothing else uses while a menu is up. The level binds its own again
   * every frame it draws, so a menu leaving these bound costs it nothing.
   */
  private backdrop(w: Extract<Widget, { kind: "backdrop" }>, view: UiViewport): void {
    const gl = this.gl.gl;
    const sky = w.noSky ? null : this.sky;
    const ground = this.ground;
    if (sky) {
      gl.activeTexture(gl.TEXTURE0 + SHEET_BACKGROUND);
      gl.bindTexture(gl.TEXTURE_2D, sky.texture);
      // Drawn at its own size unless the view is taller, so the art never
      // meets itself top to bottom; across, the tile repeats.
      const size = Math.max(sky.height, view.height);
      const scroll = w.offset * MENU_SKY_PARALLAX;
      const quad: UiQuad = { u0: scroll / size, v0: 0, du: view.width / size, dv: view.height / size, unit: SHEET_BACKGROUND, w: view.width, h: view.height };
      this.batch.stretched(quad, { x: 0, y: 0, w: view.width, h: view.height }, w.tint);
    }
    if (ground) {
      gl.activeTexture(gl.TEXTURE0 + SHEET_GROUND);
      gl.bindTexture(gl.TEXTURE_2D, ground.texture);
      // Hangs from the line, so the bottom of the tile can fall off the screen
      // and the join with the sky is always the tile's own top edge.
      const quad: UiQuad = { u0: w.offset / ground.width, v0: 0, du: view.width / ground.width, dv: 1, unit: SHEET_GROUND, w: view.width, h: ground.height };
      this.batch.stretched(quad, { x: 0, y: w.groundTop - ground.height, w: view.width, h: ground.height }, w.groundTint);
    }
  }

  private fontFor(name: FontName | undefined): { font: FontName; unit: number } | null {
    const wanted = name ?? "bigFont";
    if (this.art.isPacked(wanted)) return { font: wanted, unit: SHEET_UI };
    const unit = this.fontUnits.get(wanted);
    if (unit === undefined || !this.fontTextures.has(wanted)) {
      this.missing.add(`font ${wanted}`);
      return null;
    }
    return { font: wanted, unit };
  }

  /**
   * Text placed at `x`, `y`.
   *
   * `align` anchors the whole block as well as the lines inside it: left puts
   * the bottom-left corner there, center treats `x` as the middle and right as
   * the right edge. Aligning the lines but not the block is the trap — a caller
   * passing the middle of the screen would get text starting there instead.
   */
  private text(value: string, x: number, y: number, spec: TextOptions & { font?: FontName; tint?: Tint; alpha?: number }): void {
    const bound = this.fontFor(spec.font);
    const font = bound && this.art.font(bound.font);
    if (!bound || !font) return;
    const placed = layout(font, this.art.fontPxPerUnit, value, spec);
    const left = spec.align === "center" ? x - placed.width / 2 : spec.align === "right" ? x - placed.width : x;
    this.batch.text(placed.glyphs, (code) => this.art.glyph(bound.font, bound.unit, code), left, y, spec.tint ?? UI_COLOURS.text, spec.alpha ?? 1);
  }

  private centredLabel(spec: { text: string; font?: FontName; scale?: number; maxWidth?: number }, box: Rect, tint: Tint): void {
    const bound = this.fontFor(spec.font);
    const font = bound && this.art.font(bound.font);
    if (!bound || !font) return;
    const opts = { scale: spec.scale ?? 0.4, maxWidth: spec.maxWidth };
    const size = measure(font, this.art.fontPxPerUnit, spec.text, opts);
    this.text(spec.text, box.x + (box.w - size.width) / 2, box.y + (box.h - size.height) / 2, { ...opts, font: spec.font, tint });
  }

  private leftLabel(spec: { text: string; font?: FontName; scale?: number; maxWidth?: number }, box: Rect, tint: Tint): void {
    const bound = this.fontFor(spec.font);
    const font = bound && this.art.font(bound.font);
    if (!bound || !font) return;
    const opts = { scale: spec.scale ?? 0.35, maxWidth: spec.maxWidth };
    const size = measure(font, this.art.fontPxPerUnit, spec.text, opts);
    this.text(spec.text, box.x, box.y + (box.h - size.height) / 2, { ...opts, font: spec.font, tint });
  }
}

/** A rectangle scaled about its own centre. */
export function grown(r: Rect, by: number): Rect {
  const w = r.w * by;
  const h = r.h * by;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Re-exported so a screen does not have to reach past the renderer for them. */
export { flatten, listMetrics, rowRect };
export type { IconSet };
