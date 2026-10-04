// Asset viewer, sheets tab: one sprite sheet at a time with its frame
// rectangles drawn over it.
//
// This is the tab that proves the atlas conversion. If the rotation rule were
// wrong the outlines on rotated frames would be visibly square-on to the art
// instead of around it, and if the trim conversion were wrong the source boxes
// would sit off centre.

import { AtlasSet } from "../assets/atlas";
import { framePackedRect, frameSourceRect, frameSourceSize, frameTrimOffset, type Atlas, type AtlasFrame } from "../assets/atlasTypes";
import type { TabView } from "./tabs";
import type { Viewport } from "./viewport";

export interface AtlasTabDom {
  pick: HTMLSelectElement;
  res: HTMLSelectElement;
  filter: HTMLInputElement;
  outlines: HTMLInputElement;
  source: HTMLInputElement;
  rotated: HTMLInputElement;
  labels: HTMLInputElement;
  checker: HTMLInputElement;
  fit: HTMLButtonElement;
}

export class AtlasTab implements TabView {
  readonly id = "atlas";
  private set: AtlasSet | null = null;
  private index = 0;
  private image: HTMLImageElement | null = null;
  private hovered: AtlasFrame | null = null;

  constructor(
    private readonly viewport: Viewport,
    private readonly dom: AtlasTabDom,
    private readonly redraw: () => void,
    private readonly setMessage: (text: string) => void,
    private readonly params: URLSearchParams,
  ) {
    dom.pick.addEventListener("change", () => void this.select(Number(dom.pick.value)));
    dom.res.addEventListener("change", () => void this.load(dom.res.value === "hd" ? "hd" : "uhd"));
    for (const box of [dom.outlines, dom.source, dom.rotated, dom.labels, dom.checker]) box.addEventListener("change", redraw);
    dom.filter.addEventListener("input", redraw);
    dom.filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.frameMatches();
    });
    dom.fit.addEventListener("click", () => {
      const atlas = this.atlas;
      if (atlas) this.viewport.fit(atlas.w, atlas.h);
      redraw();
    });
  }

  private get atlas(): Atlas | null {
    return this.set?.atlases[this.index] ?? null;
  }

  async activate(): Promise<void> {
    if (this.set) return;
    const wanted = this.params.get("res") === "hd" ? "hd" : "uhd";
    this.dom.res.value = wanted;
    const set = await this.load(wanted);
    const name = this.params.get("sheet");
    if (!name || !set) return;
    const i = set.atlases.findIndex((a) => a.name === name);
    if (i >= 0) {
      this.dom.pick.value = String(i);
      await this.select(i);
    }
  }

  private async load(res: "uhd" | "hd"): Promise<AtlasSet | null> {
    this.setMessage("");
    try {
      this.set = await AtlasSet.load(res);
    } catch (err) {
      this.setMessage(err instanceof Error ? err.message : String(err));
      return null;
    }
    this.dom.pick.innerHTML = "";
    this.set.atlases.forEach((atlas, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `${atlas.name}  (${atlas.frames.length})`;
      this.dom.pick.append(option);
    });
    const keep = Math.max(0, Math.min(this.index, this.set.atlases.length - 1));
    this.dom.pick.value = String(keep);
    await this.select(keep);
    return this.set;
  }

  private async select(index: number): Promise<void> {
    if (!this.set) return;
    this.index = index;
    this.image = null;
    const atlas = this.set.atlases[index];
    if (!atlas) return;
    this.viewport.fit(atlas.w, atlas.h);
    this.redraw();
    try {
      this.image = await this.set.image(index);
    } catch (err) {
      this.setMessage(err instanceof Error ? err.message : String(err));
    }
    this.redraw();
  }

  /** Zooms to everything the filter matches, so one frame can be inspected. */
  private frameMatches(): void {
    const atlas = this.atlas;
    const filter = this.dom.filter.value.trim().toLowerCase();
    if (!atlas || filter === "") return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let count = 0;
    for (const frame of atlas.frames) {
      if (!frame.n.toLowerCase().includes(filter)) continue;
      const r = framePackedRect(frame);
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
      count++;
    }
    if (count === 0) {
      this.setMessage(`no frame matches "${filter}"`);
      return;
    }
    this.setMessage(`${count} frame(s)`);
    const pad = 8;
    this.viewport.x = (x0 + x1) / 2;
    this.viewport.y = (y0 + y1) / 2;
    this.viewport.zoom = Math.min(this.viewport.width / (x1 - x0 + pad * 2), this.viewport.height / (y1 - y0 + pad * 2));
    this.redraw();
  }

  draw(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const atlas = this.atlas;
    if (!atlas) return;
    viewport.apply(ctx);

    if (this.dom.checker.checked) {
      const cell = 16;
      ctx.fillStyle = "#1a1a22";
      ctx.fillRect(0, 0, atlas.w, atlas.h);
      ctx.fillStyle = "#232330";
      for (let y = 0; y < atlas.h; y += cell) {
        for (let x = (y / cell) % 2 === 0 ? 0 : cell; x < atlas.w; x += cell * 2) {
          ctx.fillRect(x, y, cell, Math.min(cell, atlas.h - y));
        }
      }
    }
    if (this.image) ctx.drawImage(this.image, 0, 0);

    const filter = this.dom.filter.value.trim().toLowerCase();
    const px = 1 / viewport.zoom;
    const view = viewport.visible();
    const world = viewport.pointer ? viewport.toWorld(viewport.pointer.x, viewport.pointer.y) : null;
    this.hovered = null;

    for (const frame of atlas.frames) {
      const r = framePackedRect(frame);
      if (r.x > view.x1 || r.y > view.y1 || r.x + r.w < view.x0 || r.y + r.h < view.y0) continue;
      if (filter !== "" && !frame.n.toLowerCase().includes(filter)) {
        ctx.fillStyle = "rgba(10,10,14,0.72)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        continue;
      }
      if (world && world.x >= r.x && world.x < r.x + r.w && world.y >= r.y && world.y < r.y + r.h) this.hovered = frame;
      if (this.dom.outlines.checked) {
        ctx.lineWidth = px;
        ctx.strokeStyle = frame.r && this.dom.rotated.checked ? "rgba(255,170,60,0.9)" : "rgba(90,200,255,0.75)";
        ctx.strokeRect(r.x + px / 2, r.y + px / 2, r.w - px, r.h - px);
      }
      if (this.dom.source.checked) {
        const box = frameSourceRect(frame);
        ctx.lineWidth = px;
        ctx.strokeStyle = "rgba(120,255,140,0.55)";
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
    }

    if (this.hovered) {
      const r = framePackedRect(this.hovered);
      ctx.lineWidth = px * 2;
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    if (this.dom.labels.checked && viewport.zoom > 0.6) {
      ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (const frame of atlas.frames) {
        if (filter !== "" && !frame.n.toLowerCase().includes(filter)) continue;
        const r = framePackedRect(frame);
        const p = viewport.toScreen(r.x, r.y);
        if (p.x < -200 || p.y < -20 || p.x > viewport.width + 200 || p.y > viewport.height + 20) continue;
        ctx.fillText(frame.n.replace(/\.png$/, ""), p.x + 2, p.y - 3);
      }
    }
  }

  hud(): string {
    const atlas = this.atlas;
    if (!this.set || !atlas) return "";
    const lines = [
      `${atlas.name}  ${atlas.w}×${atlas.h} px  ${atlas.frames.length} frames  (${this.set.res}, ${this.set.pxPerUnit} px per unit)`,
      `sheets ${this.set.atlases.length}  frames indexed ${this.set.frameCount}`,
    ];
    const f = this.hovered;
    if (f) {
      const r = framePackedRect(f);
      const src = frameSourceSize(f);
      const off = frameTrimOffset(f);
      lines.push(
        "",
        f.n,
        `packed  ${r.x},${r.y}  ${r.w}×${r.h}${f.r ? "  rotated 90° cw" : ""}`,
        `source  ${src.w}×${src.h} px = ${(src.w / this.set.pxPerUnit).toFixed(2)}×${(src.h / this.set.pxPerUnit).toFixed(2)} units, upright`,
        `trim    ${off.x},${off.y} from the top left of that box`,
      );
      // For a rotated frame the source box is turned too, so the upright
      // numbers above are not what the green outline covers.
      if (f.r) {
        const box = frameSourceRect(f);
        lines.push(`on sheet  ${box.x},${box.y}  ${box.w}×${box.h}`);
      }
      lines.push("click to copy the name");
    }
    return lines.join("\n");
  }

  click(): void {
    if (!this.hovered) return;
    void navigator.clipboard?.writeText(this.hovered.n);
    this.setMessage(`copied ${this.hovered.n}`);
  }
}
