// What the mod menu draws over the level: hitboxes, the status lines in the
// corner and the red flash noclip makes.
//
// The hitboxes go on a 2D canvas laid over the game's own, placed through the
// frame the level was last drawn in (Scene.viewPoint), so they move with its
// zoom, turn and shake.

import type { ObjectKind, Rect, Sim, WorldShape } from "../physics/types";
import type { Scene } from "../render/scene";

/** Mega Hack's colours: solids blue, hazards red, everything you touch on purpose green. */
const KIND_COLOUR: Partial<Record<ObjectKind, string>> = {
  solid: "#3f8cff",
  slope: "#3f8cff",
  hazard: "#ff3030",
  orb: "#32ff6a",
  pad: "#32ff6a",
  portal: "#32ff6a",
  collectible: "#ffd23f",
  checkpoint: "#32ff6a",
  forceBlock: "#c070ff",
};
const PLAYER_OUTER = "#ff3030";
const PLAYER_INNER = "#3f8cff";
const TRAIL_COLOUR = "rgba(255, 80, 80, 0.45)";
/** One and a half seconds of the hitbox trail. */
const TRAIL_TICKS = 360;

export class HitboxLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private drawn = false;
  private readonly at: [number, number] = [0, 0];
  /** The player's outer box each step, oldest first, for the trail. */
  private readonly trail: Rect[] = [];

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "mods-hitboxes";
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    this.ctx = ctx;
  }

  /** Notes the player's box after a step, for the trail. */
  record(sim: Sim): void {
    if (sim.state.dead) return;
    this.trail.push(sim.playerRect(1));
    if (this.trail.length > TRAIL_TICKS) this.trail.shift();
  }

  forgetTrail(): void {
    this.trail.length = 0;
  }

  clear(): void {
    if (!this.drawn) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = false;
  }

  draw(sim: Sim, scene: Scene, objects: boolean, trail: boolean): void {
    this.fit();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawn = true;
    ctx.lineWidth = 1.5;
    if (trail) {
      ctx.strokeStyle = TRAIL_COLOUR;
      for (const r of this.trail) this.rect(scene, r, 0);
    }
    if (objects) {
      const b = scene.camera.coverBounds(30, scene.drawnAlpha);
      for (const o of sim.query(b.x0, b.y0, b.x1, b.y1)) {
        const kind = sim.objects.has(o.id) ? sim.objects.get(o.id).kind : "unknown";
        const colour = KIND_COLOUR[kind];
        if (!colour) continue;
        const shape = sim.hitboxOf(o.index);
        if (!shape) continue;
        const killer = sim.state.killedBy === o.index || sim.state2?.killedBy === o.index;
        ctx.strokeStyle = killer ? "#ffffff" : colour;
        ctx.fillStyle = colour + "22";
        ctx.lineWidth = killer ? 3 : 1.5;
        this.shape(scene, shape);
      }
    }
    ctx.lineWidth = 1.5;
    for (const which of sim.state2 ? ([1, 2] as const) : ([1] as const)) {
      ctx.strokeStyle = PLAYER_OUTER;
      this.rect(scene, sim.playerRect(which), 0);
      ctx.strokeStyle = PLAYER_INNER;
      this.rect(scene, sim.playerInnerRect(which), 0);
    }
  }

  private fit(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === this.width && h === this.height && this.canvas.width === Math.round(w * dpr)) return;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /** A world point on the page, in CSS pixels from the top left. */
  private point(scene: Scene, x: number, y: number): [number, number] {
    scene.viewPoint(x, y, this.at);
    return [this.at[0] * this.width, (1 - this.at[1]) * this.height];
  }

  private polygon(scene: Scene, pts: ReadonlyArray<readonly [number, number]>, fill: boolean): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [sx, sy] = this.point(scene, x, y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    if (fill) ctx.fill();
    ctx.stroke();
  }

  /** A box turned `rotation` degrees clockwise about its centre. */
  private rect(scene: Scene, r: Rect, rotation: number, fill = false): void {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const a = (rotation * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const hw = r.w / 2;
    const hh = r.h / 2;
    const corners: Array<[number, number]> = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    this.polygon(
      scene,
      corners.map(([dx, dy]) => [cx + dx * c + dy * s, cy - dx * s + dy * c] as const),
      fill,
    );
  }

  private shape(scene: Scene, shape: WorldShape): void {
    switch (shape.type) {
      case "rect":
        this.rect(scene, shape.rect, shape.rotation, true);
        return;
      case "triangle":
        this.polygon(scene, [[shape.ax, shape.ay], [shape.bx, shape.by], [shape.cx, shape.cy]], true);
        return;
      case "circle": {
        const [x, y] = this.point(scene, shape.cx, shape.cy);
        const [ex, ey] = this.point(scene, shape.cx + shape.r, shape.cy);
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(x, y, Math.hypot(ex - x, ey - y), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

/** The status lines, top left. */
export class StatusPanel {
  private readonly el: HTMLDivElement;
  private shown = "";

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "mods-status";
    parent.appendChild(this.el);
  }

  /** Lines as [text, colour]; the colour is CSS, absent for white. */
  show(lines: ReadonlyArray<readonly [string, string?]>, size: number, opacity: number): void {
    const key = `${size}|${opacity}|${lines.map(([t, c]) => `${c ?? ""}:${t}`).join("\n")}`;
    if (key === this.shown) return;
    this.shown = key;
    this.el.style.fontSize = `${14 * size}px`;
    this.el.style.opacity = String(opacity);
    this.el.replaceChildren(
      ...lines.map(([text, colour]) => {
        const line = document.createElement("div");
        line.textContent = text;
        if (colour) line.style.color = colour;
        return line;
      }),
    );
  }
}

/** A red wash over the whole screen, faded out after each flash. */
export class Flash {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "mods-flash";
    parent.appendChild(this.el);
  }

  flash(): void {
    this.el.style.transition = "none";
    this.el.style.opacity = "0.3";
    // Read back so the browser lays the full wash down before fading it.
    void this.el.offsetWidth;
    this.el.style.transition = "opacity 0.35s ease-out";
    this.el.style.opacity = "0";
  }
}
