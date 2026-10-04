// Asset viewer, objects tab: one object id drawn the way the renderer will
// have to draw it, with its hitbox over the top.
//
// This is what turns "zero missing frames" from a number into something
// someone has looked at. Census mode walks every id the official levels use,
// most common first, so the whole set can be paged through in a few minutes.

import { AtlasSet } from "../assets/atlas";
import { frameSourceSize, frameTrimOffset } from "../assets/atlasTypes";
import type { ChildRecord, ObjectRecord, ObjectsFile } from "../assets/objectTypes";
import { GAME_ANIMATIONS } from "../assets/gameAnimations";
import { fetchAsset } from "../assets/paths";
import { objectAnimationFor } from "../render/anim";
import type { Hitbox } from "../physics/types";
import type { TabView } from "./tabs";
import type { Viewport } from "./viewport";

export interface ObjectTabDom {
  id: HTMLInputElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  census: HTMLInputElement;
  hitbox: HTMLInputElement;
  children: HTMLInputElement;
  glow: HTMLInputElement;
  grid: HTMLInputElement;
}

const BLOCK = 30;

export class ObjectTab implements TabView {
  readonly id = "objects";
  private file: ObjectsFile | null = null;
  private set: AtlasSet | null = null;
  private current = 1;
  private images = new Map<number, HTMLImageElement>();

  constructor(
    private readonly viewport: Viewport,
    private readonly dom: ObjectTabDom,
    private readonly redraw: () => void,
    private readonly setMessage: (text: string) => void,
  ) {
    dom.id.addEventListener("change", () => this.go(Number(dom.id.value)));
    dom.prev.addEventListener("click", () => this.step(-1));
    dom.next.addEventListener("click", () => this.step(1));
    for (const box of [dom.census, dom.hitbox, dom.children, dom.glow, dom.grid]) box.addEventListener("change", redraw);
    window.addEventListener("keydown", (e) => {
      if (document.activeElement === dom.id) return;
      if (e.key === "ArrowRight") this.step(1);
      else if (e.key === "ArrowLeft") this.step(-1);
    });
  }

  async activate(): Promise<void> {
    if (this.file) return;
    try {
      this.file = await fetchAsset<ObjectsFile>("objects.json");
      this.set = await AtlasSet.load("uhd");
    } catch (err) {
      this.setMessage(err instanceof Error ? err.message : String(err));
      return;
    }
    this.go(this.current);
  }

  /** The list the arrows walk: the census in order, or every id. */
  private list(): number[] {
    if (!this.file) return [];
    return this.dom.census.checked ? [...this.file.census] : Object.keys(this.file.objects).map(Number).sort((a, b) => a - b);
  }

  private step(by: number): void {
    const list = this.list();
    if (list.length === 0) return;
    const at = list.indexOf(this.current);
    const next = at < 0 ? 0 : (at + by + list.length) % list.length;
    this.go(list[next]);
  }

  private go(id: number): void {
    if (!Number.isInteger(id)) return;
    this.current = id;
    this.dom.id.value = String(id);
    this.viewport.x = 0;
    this.viewport.y = 0;
    this.viewport.zoom = Math.min(this.viewport.width, this.viewport.height) / (BLOCK * 6);
    void this.preload();
    this.redraw();
  }

  /** Loads every sheet this object draws from, then redraws. */
  private async preload(): Promise<void> {
    const rec = this.record;
    if (!rec || !this.set) return;
    const names = new Set<string>();
    const walk = (children: ChildRecord[] | undefined): void => {
      for (const c of children ?? []) {
        names.add(c.f);
        if (c.g) names.add(c.g);
        walk(c.ch);
      }
    };
    if (rec.f) names.add(rec.f);
    if (rec.g) names.add(rec.g);
    walk(rec.ch);
    const set = this.set;
    const animation = objectAnimationFor(this.current, (n) => set.frame(n) !== undefined);
    const game = GAME_ANIMATIONS.get(this.current);
    if (animation && game) {
      for (const stem of [game.name, game.color]) {
        if (stem) for (const a of animation.framesFor(`${stem}_001.png`, stem === game.color) ?? []) names.add(a.f);
      }
    }
    const indexes = new Set<number>();
    for (const name of names) {
      const at = this.set.frame(name);
      if (at) indexes.add(at.atlasIndex);
    }
    for (const i of indexes) {
      if (this.images.has(i)) continue;
      try {
        this.images.set(i, await this.set.image(i));
      } catch (err) {
        this.setMessage(err instanceof Error ? err.message : String(err));
      }
    }
    this.redraw();
  }

  private get record(): ObjectRecord | undefined {
    return this.file?.objects[String(this.current)];
  }

  /** Draws one frame centred on (x, y) in object space, y up. */
  private sprite(ctx: CanvasRenderingContext2D, name: string, alpha: number): void {
    if (!this.set) return;
    const at = this.set.frame(name);
    if (!at) return;
    const image = this.images.get(at.atlasIndex);
    if (!image) return;
    const f = at.frame;
    const scale = 1 / this.set.pxPerUnit;
    const src = frameSourceSize(f);
    const off = frameTrimOffset(f);
    // Texture space has y down; object space has y up, so the whole sprite is
    // drawn in a flipped frame and the trim offset applies from the top left.
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.scale(scale, -scale);
    const dx = -src.w / 2 + off.x;
    const dy = -src.h / 2 + off.y;
    if (f.r) {
      // Stored turned 90° clockwise: rotate the destination back.
      ctx.translate(dx + f.w / 2, dy + f.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(image, f.x, f.y, f.h, f.w, -f.h / 2, -f.w / 2, f.h, f.w);
    } else {
      ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
    }
    ctx.restore();
  }

  private drawChildren(ctx: CanvasRenderingContext2D, children: ChildRecord[] | undefined): void {
    for (const c of [...(children ?? [])].sort((a, b) => a.z - b.z)) {
      ctx.save();
      ctx.translate(c.dx, c.dy);
      if (c.rot) ctx.rotate((-c.rot * Math.PI) / 180);
      if (c.sx !== undefined || c.sy !== undefined) ctx.scale(c.sx ?? 1, c.sy ?? 1);
      if (this.dom.glow.checked && c.g) this.sprite(ctx, c.g, 0.5);
      if (!c.dd) this.sprite(ctx, c.f, c.a ?? 1);
      this.drawChildren(ctx, c.ch);
      ctx.restore();
    }
  }

  private drawHitbox(ctx: CanvasRenderingContext2D, hb: Hitbox): void {
    if (!hb) return;
    ctx.lineWidth = 2 / this.viewport.zoom;
    ctx.strokeStyle = "rgba(255,80,80,0.95)";
    if (hb.type === "box") ctx.strokeRect(hb.ox - hb.w / 2, -(hb.oy + hb.h / 2), hb.w, hb.h);
    else if (hb.type === "circle") {
      ctx.beginPath();
      ctx.arc(hb.ox, -hb.oy, hb.r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-hb.w / 2, hb.h / 2);
      ctx.lineTo(hb.w / 2, hb.h / 2);
      ctx.lineTo(hb.w / 2, -hb.h / 2);
      ctx.closePath();
      ctx.stroke();
    }
  }

  draw(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const rec = this.record;
    viewport.apply(ctx);

    if (this.dom.grid.checked) {
      const view = viewport.visible();
      ctx.lineWidth = 1 / viewport.zoom;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      for (let x = Math.floor(view.x0 / BLOCK) * BLOCK; x < view.x1; x += BLOCK) {
        ctx.moveTo(x, view.y0);
        ctx.lineTo(x, view.y1);
      }
      for (let y = Math.floor(view.y0 / BLOCK) * BLOCK; y < view.y1; y += BLOCK) {
        ctx.moveTo(view.x0, y);
        ctx.lineTo(view.x1, y);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(view.x0, 0);
      ctx.lineTo(view.x1, 0);
      ctx.moveTo(0, view.y0);
      ctx.lineTo(0, view.y1);
      ctx.stroke();
    }
    if (!rec) return;

    // Object space is y up; the canvas is y down, so everything below draws
    // inside one flip.
    ctx.save();
    ctx.scale(1, -1);
    if (this.dom.children.checked) this.drawChildren(ctx, rec.ch?.filter((c) => c.z < 0));
    if (this.dom.glow.checked && rec.g) this.sprite(ctx, rec.g, 0.5);
    if (rec.f && !rec.dd) this.sprite(ctx, rec.f, rec.a ?? 1);
    if (this.dom.children.checked) this.drawChildren(ctx, rec.ch?.filter((c) => c.z >= 0));
    ctx.restore();

    if (this.dom.hitbox.checked) this.drawHitbox(ctx, rec.hb);
  }

  hud(): string {
    if (!this.file) return "";
    const rec = this.record;
    const list = this.list();
    const at = list.indexOf(this.current);
    const lines = [
      `object ${this.current}${at >= 0 ? `  (${at + 1} of ${list.length}${this.dom.census.checked ? " used by the levels" : ""})` : ""}`,
      "← → to page, arrow keys work too",
    ];
    if (!rec) {
      lines.push("", "no record for this id");
      return lines.join("\n");
    }
    const bits = [`kind ${rec.k}`, `art ${rec.p.art}`, `hitbox ${rec.p.hb}`];
    lines.push("", bits.join("  "));
    lines.push(`frame   ${rec.f ?? "none"}${rec.g ? `  glow ${rec.g}` : ""}`);
    if (rec.ch) lines.push(`children ${rec.ch.length}`);
    const game = GAME_ANIMATIONS.get(this.current);
    if (game && game.frames > 1) lines.push(`animated ${game.frames} frames every ${(game.time * 1000).toFixed(0)} ms`);
    if (rec.txt) lines.push(`text    "${rec.txt.def}" in ${rec.txt.font} at ${rec.txt.size}`);
    if (rec.ent) lines.push(`skeleton ${rec.ent}`);
    if (rec.hb) lines.push(`hitbox  ${rec.hb.type === "box" ? `${rec.hb.w}×${rec.hb.h}` : rec.hb.type === "circle" ? `r ${rec.hb.r}` : `slope ${rec.hb.w}×${rec.hb.h}`}`);
    lines.push(`z       layer ${rec.zl ?? "-"} order ${rec.zo ?? "-"}  colour ${rec.bc ?? "-"}/${rec.dc ?? "-"}${rec.ct ? ` (${rec.ct})` : ""}`);
    return lines.join("\n");
  }
}
