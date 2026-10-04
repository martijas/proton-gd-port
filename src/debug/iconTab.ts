// Asset viewer, icons tab: every icon of one game mode, composited from its
// packed layers exactly the way the game stacks them.
//
// The colour pickers matter more than they look. An icon is a base shape tinted
// with colour one, a secondary layer tinted with colour two, an extra layer
// that keeps its own colours and a glow outline behind everything. Drawing them
// flat would hide a layer that is packed but mis-registered; drawing them tinted
// makes a wrong offset or a swapped role obvious.

import { assetUrl, fetchAsset } from "../assets/paths";
import { frameSourceSize, frameTrimOffset, type AtlasFrame } from "../assets/atlasTypes";
import { ICON_LAYER_ORDER, type IconDef, type IconFile, type IconKind } from "../assets/iconTypes";
import type { TabView } from "./tabs";
import type { Viewport } from "./viewport";

export interface IconTabDom {
  kind: HTMLSelectElement;
  color1: HTMLInputElement;
  color2: HTMLInputElement;
  glow: HTMLInputElement;
  fit: HTMLButtonElement;
}

/** One grid cell, in world units. The icons themselves are drawn to fit it. */
const CELL = 120;
const GAP = 12;
const COLUMNS = 16;

interface Cell {
  icon: IconDef;
  col: number;
  row: number;
}

export class IconTab implements TabView {
  readonly id = "icons";
  private file: IconFile | null = null;
  private readonly pages = new Map<number, HTMLImageElement>();
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private cells: Cell[] = [];
  private kind: IconKind = "cube";
  private hovered: IconDef | null = null;

  constructor(
    private readonly viewport: Viewport,
    private readonly dom: IconTabDom,
    private readonly redraw: () => void,
    private readonly setMessage: (text: string) => void,
  ) {
    dom.kind.addEventListener("change", () => {
      this.kind = dom.kind.value as IconKind;
      this.layout();
      this.frameAll();
      this.redraw();
    });
    for (const input of [dom.color1, dom.color2, dom.glow]) {
      input.addEventListener("input", () => {
        this.cache.clear();
        this.redraw();
      });
    }
    dom.fit.addEventListener("click", () => {
      this.frameAll();
      this.redraw();
    });
  }

  async activate(): Promise<void> {
    if (this.file) return;
    try {
      this.file = await fetchAsset<IconFile>("icons/icons.json");
    } catch (err) {
      this.setMessage(err instanceof Error ? err.message : String(err));
      return;
    }
    this.dom.kind.innerHTML = "";
    for (const [kind, group] of Object.entries(this.file.kinds)) {
      const option = document.createElement("option");
      option.value = kind;
      option.textContent = `${kind} (${group.count})`;
      this.dom.kind.append(option);
    }
    this.dom.kind.value = this.kind;
    this.layout();
    this.frameAll();
    await Promise.all(this.file.pages.map((_, i) => this.page(i)));
    this.redraw();
  }

  private layout(): void {
    const group = this.file?.kinds[this.kind];
    this.cells = (group?.icons ?? []).map((icon, i) => ({ icon, col: i % COLUMNS, row: Math.floor(i / COLUMNS) }));
  }

  private frameAll(): void {
    const rows = Math.max(1, Math.ceil(this.cells.length / COLUMNS));
    this.viewport.fit(COLUMNS * (CELL + GAP), rows * (CELL + GAP));
    this.viewport.x = (COLUMNS * (CELL + GAP)) / 2;
    this.viewport.y = (rows * (CELL + GAP)) / 2;
  }

  private page(index: number): Promise<HTMLImageElement> {
    const held = this.pages.get(index);
    if (held) return Promise.resolve(held);
    const page = this.file?.pages[index];
    if (!page) return Promise.reject(new Error(`no icon page ${index}`));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.pages.set(index, img);
        this.redraw();
        resolve(img);
      };
      img.onerror = () => reject(new Error(`${page.image} could not be loaded`));
      img.src = assetUrl(page.image);
    });
  }

  private frameOf(name: string): { page: number; frame: AtlasFrame } | null {
    const at = this.file?.frames[name];
    if (!at || !this.file) return null;
    const frame = this.file.pages[at[0]]?.frames[at[1]];
    return frame ? { page: at[0], frame } : null;
  }

  /** Composites one icon into a CELL-sized canvas, tinted and cached. */
  private render(icon: IconDef): HTMLCanvasElement | null {
    const key = `${icon.name}|${this.dom.color1.value}|${this.dom.color2.value}|${this.dom.glow.checked ? 1 : 0}`;
    const held = this.cache.get(key);
    if (held) return held;
    if (!this.file) return null;

    // Everything is measured in the icon's own pixels first, then scaled to
    // the cell, so layers keep their relative positions.
    let w = 0;
    let h = 0;
    for (const layer of icon.layers) {
      const found = this.frameOf(layer.n);
      if (!found) continue;
      const src = frameSourceSize(found.frame);
      w = Math.max(w, src.w);
      h = Math.max(h, src.h);
    }
    if (w === 0 || h === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = CELL;
    canvas.height = CELL;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const scale = Math.min(CELL / w, CELL / h);
    ctx.translate(CELL / 2, CELL / 2);
    ctx.scale(scale, scale);

    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d");
    if (!sctx) return null;

    for (const role of ICON_LAYER_ORDER) {
      if (role === "glow" && !this.dom.glow.checked) continue;
      for (const layer of icon.layers) {
        if (layer.role !== role) continue;
        const found = this.frameOf(layer.n);
        if (!found) continue;
        const image = this.pages.get(found.page);
        if (!image) continue;
        const f = found.frame;
        const src = frameSourceSize(f);
        const off = frameTrimOffset(f);
        const tint = role === "base" ? this.dom.color1.value : role === "secondary" ? this.dom.color2.value : null;
        const dx = -src.w / 2 + off.x;
        const dy = -src.h / 2 + off.y;
        if (!tint) {
          ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
          continue;
        }
        // Multiply the layer by the colour, then mask back to its own alpha.
        scratch.width = f.w;
        scratch.height = f.h;
        sctx.clearRect(0, 0, f.w, f.h);
        sctx.globalCompositeOperation = "source-over";
        sctx.drawImage(image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
        sctx.globalCompositeOperation = "multiply";
        sctx.fillStyle = tint;
        sctx.fillRect(0, 0, f.w, f.h);
        sctx.globalCompositeOperation = "destination-in";
        sctx.drawImage(image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
        ctx.drawImage(scratch, dx, dy);
      }
    }
    this.cache.set(key, canvas);
    return canvas;
  }

  draw(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.file) return;
    viewport.apply(ctx);
    const view = viewport.visible();
    const world = viewport.pointer ? viewport.toWorld(viewport.pointer.x, viewport.pointer.y) : null;
    this.hovered = null;

    for (const cell of this.cells) {
      const x = cell.col * (CELL + GAP);
      const y = cell.row * (CELL + GAP);
      if (x > view.x1 || y > view.y1 || x + CELL < view.x0 || y + CELL < view.y0) continue;
      const image = this.render(cell.icon);
      ctx.fillStyle = image ? "rgba(255,255,255,0.05)" : "rgba(255,60,60,0.35)";
      ctx.fillRect(x, y, CELL, CELL);
      if (image) ctx.drawImage(image, x, y);
      if (world && world.x >= x && world.x < x + CELL && world.y >= y && world.y < y + CELL) {
        this.hovered = cell.icon;
        ctx.lineWidth = 2 / viewport.zoom;
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(x, y, CELL, CELL);
      }
      if (viewport.zoom > 0.35) {
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = `${Math.round(14 / 1)}px ui-monospace, monospace`;
        ctx.fillText(String(cell.icon.id), x + 3, y + 15);
      }
    }
  }

  hud(): string {
    if (!this.file) return "";
    const group = this.file.kinds[this.kind];
    const pages = new Set(this.cells.map((c) => c.icon.page));
    const lines = [
      `${this.kind}: ${group?.count ?? 0} icons on ${pages.size} page(s)  (${this.file.res}, ${this.file.pxPerUnit} px per unit)`,
      `${this.file.pages.length} pages in total, ${Object.keys(this.file.frames).length} frames`,
    ];
    if (this.kind === "robot" || this.kind === "spider") {
      lines.push("limbs are stacked at one origin here; where each one sits comes from the animation files");
    }
    if (this.hovered) {
      const layers = this.hovered.layers.map((l) => (l.part ? `${l.role}${l.part}` : l.role));
      lines.push("", `${this.hovered.name}  id ${this.hovered.id}  page ${this.hovered.page}`, `layers  ${layers.join(" ")}`);
    }
    return lines.join("\n");
  }

  click(): void {
    if (!this.hovered) return;
    void navigator.clipboard?.writeText(this.hovered.name);
    this.setMessage(`copied ${this.hovered.name}`);
  }
}
