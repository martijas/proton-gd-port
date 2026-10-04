import type { LevelObject } from "../level/types";
import type { ObjectKind, PlayerState, Rect, Sim, WorldShape } from "../physics/types";

/** Ground grid pitch: one block. */
const BLOCK = 30;
/** One second of positions at 240 Hz. */
const TRAIL_LENGTH = 240;
/** Fraction of the viewport width the player sits from the left edge. */
export const PLAYER_SCREEN_FRACTION = 1 / 3;
/** Per-frame lerp factor for the vertical camera follow. */
const CAMERA_Y_FOLLOW = 0.12;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

const KIND_COLOR: Record<ObjectKind, string> = {
  solid: "rgba(190,190,190,0.9)",
  hazard: "rgba(255,60,60,0.95)",
  slope: "rgba(255,150,40,0.95)",
  orb: "rgba(255,230,60,0.95)",
  pad: "rgba(80,230,80,0.95)",
  portal: "rgba(60,220,255,0.95)",
  collectible: "rgba(255,200,0,0.95)",
  checkpoint: "rgba(120,255,120,0.6)",
  trigger: "rgba(180,120,255,0.35)",
  collision: "rgba(120,120,255,0.35)",
  forceBlock: "rgba(200,120,200,0.5)",
  startPos: "rgba(120,255,200,0.5)",
  decoration: "rgba(255,255,255,0.12)",
  unknown: "rgba(255,255,255,0.12)",
};

interface Camera {
  /** World x shown at PLAYER_SCREEN_FRACTION of the width. */
  x: number;
  /** World y shown at the vertical centre. */
  y: number;
  zoom: number;
  /** Degrees the picture is turned clockwise about the canvas's centre, to match a turned level. */
  turn?: number;
}

export interface HoverInfo {
  index: number;
  id: number;
  x: number;
  y: number;
}

export class Renderer2D {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  readonly camera: Camera = { x: 0, y: 105, zoom: 1 };
  private cameraInit = false;
  private readonly trail: { x: number; y: number }[] = [];
  private trailHead = 0;
  private mouse: { x: number; y: number } | null = null;
  /** Objects under the cursor after the last draw, for the HUD. */
  hovered: HoverInfo[] = [];
  /**
   * Draw only the hitboxes, over whatever is already on screen, and let the
   * caller own the camera. This is what turns the physics view into an
   * overlay on the rendered level instead of a separate picture.
   */
  overlay = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available.");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015);
        this.camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.camera.zoom * factor));
      },
      { passive: false },
    );
    canvas.addEventListener("pointermove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerleave", () => {
      this.mouse = null;
    });
  }

  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
  }

  /** Forget the trail and snap the camera on the next draw (restart / level change). */
  reset(): void {
    this.trail.length = 0;
    this.trailHead = 0;
    this.cameraInit = false;
  }

  /** Called once per sim tick so the trail is exactly one position per tick. */
  recordPosition(p: PlayerState): void {
    if (this.trail.length < TRAIL_LENGTH) this.trail.push({ x: p.x, y: p.y });
    else {
      this.trail[this.trailHead] = { x: p.x, y: p.y };
      this.trailHead = (this.trailHead + 1) % TRAIL_LENGTH;
    }
  }

  // --- world <-> screen ----------------------------------------------------

  private sx(wx: number): number {
    return (wx - this.camera.x) * this.camera.zoom + this.width * PLAYER_SCREEN_FRACTION;
  }

  private sy(wy: number): number {
    return this.height / 2 - (wy - this.camera.y) * this.camera.zoom;
  }

  private wx(sx: number): number {
    return (sx - this.width * PLAYER_SCREEN_FRACTION) / this.camera.zoom + this.camera.x;
  }

  private wy(sy: number): number {
    return (this.height / 2 - sy) / this.camera.zoom + this.camera.y;
  }

  // --- drawing -------------------------------------------------------------

  /** Wipes the overlay without drawing anything, for when hitboxes are off. */
  clear(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  draw(sim: Sim): void {
    const p = sim.state;
    if (!this.overlay) {
      if (!this.cameraInit) {
        this.camera.x = p.x;
        this.camera.y = p.y;
        this.cameraInit = true;
      } else {
        this.camera.x = p.x;
        this.camera.y += (p.y - this.camera.y) * CAMERA_Y_FOLLOW;
      }
    }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.overlay) {
      ctx.clearRect(0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, this.width, this.height);
    }
    // A turned level is drawn turned about the screen's centre; the overlay
    // follows it, looks at the box the turned screen covers (as
    // Camera.coverBounds does), and turns the pointer back before reading
    // the world under it.
    const turn = this.camera.turn ?? 0;
    const r = (turn * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const cx = this.width / 2;
    const cy = this.height / 2;
    if (turn !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(r);
      ctx.translate(-cx, -cy);
    }
    const reachX = (this.width * Math.abs(cos) + this.height * Math.abs(sin)) / 2 / this.camera.zoom;
    const reachY = (this.width * Math.abs(sin) + this.height * Math.abs(cos)) / 2 / this.camera.zoom;
    const x0 = this.wx(cx) - reachX;
    const x1 = this.wx(cx) + reachX;
    const y1 = this.wy(cy) + reachY;
    const y0 = this.wy(cy) - reachY;

    if (!this.overlay) this.drawGrid(x0, y0, x1, y1);
    this.drawCorridor(sim, x0, x1);

    let mouseWorld: { x: number; y: number } | null = null;
    if (this.mouse) {
      const dx = this.mouse.x - cx;
      const dy = this.mouse.y - cy;
      mouseWorld = { x: this.wx(cx + dx * cos + dy * sin), y: this.wy(cy - dx * sin + dy * cos) };
    }
    this.hovered = [];
    const objects = sim.query(x0, y0, x1, y1);
    for (const o of objects) {
      const shape = sim.hitboxOf(o.index);
      if (!shape) continue;
      const kind = sim.objects.has(o.id) ? sim.objects.get(o.id).kind : "unknown";
      const killer = p.killedBy === o.index || (sim.state2 !== null && sim.state2.killedBy === o.index);
      this.drawShape(shape, KIND_COLOR[kind], killer);
      if (mouseWorld && shapeContains(shape, mouseWorld.x, mouseWorld.y)) {
        this.hovered.push({ index: o.index, id: o.id, x: o.x, y: o.y });
      }
    }
    this.drawHoverLabels(objects);

    this.drawTrail();
    this.drawPlayer(sim, 1, p);
    if (sim.state2) this.drawPlayer(sim, 2, sim.state2);
  }

  private drawGrid(x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    // Skip the grid once lines would be closer than 6 px; it turns into noise.
    if (BLOCK * z < 6) return;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.floor(x0 / BLOCK) * BLOCK; gx <= x1; gx += BLOCK) {
      const s = Math.round(this.sx(gx)) + 0.5;
      ctx.moveTo(s, 0);
      ctx.lineTo(s, this.height);
    }
    for (let gy = Math.floor(y0 / BLOCK) * BLOCK; gy <= y1; gy += BLOCK) {
      const s = Math.round(this.sy(gy)) + 0.5;
      ctx.moveTo(0, s);
      ctx.lineTo(this.width, s);
    }
    ctx.stroke();
  }

  private drawCorridor(sim: Sim, x0: number, x1: number): void {
    const ctx = this.ctx;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    const fy = this.sy(sim.floorY);
    ctx.beginPath();
    ctx.moveTo(this.sx(x0), fy);
    ctx.lineTo(this.sx(x1), fy);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, fy, this.width, Math.max(0, this.height - fy));
    if (Number.isFinite(sim.ceilingY)) {
      const cy = this.sy(sim.ceilingY);
      ctx.beginPath();
      ctx.moveTo(this.sx(x0), cy);
      ctx.lineTo(this.sx(x1), cy);
      ctx.stroke();
      ctx.fillRect(0, 0, this.width, Math.max(0, cy));
    }
  }

  private drawShape(shape: WorldShape, color: string, highlight: boolean): void {
    const ctx = this.ctx;
    ctx.strokeStyle = highlight ? "#fff" : color;
    ctx.lineWidth = highlight ? 3 : 1.5;
    ctx.fillStyle = color.replace(/[\d.]+\)$/, "0.12)");
    ctx.beginPath();
    switch (shape.type) {
      case "rect": {
        const r = shape.rect;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        if (shape.rotation === 0) {
          ctx.rect(this.sx(r.x), this.sy(r.y + r.h), r.w * this.camera.zoom, r.h * this.camera.zoom);
        } else {
          // Clockwise-positive in world (+y up) is clockwise on screen (+y down) too,
          // because both the y axis and the angle sense flip together.
          const a = (shape.rotation * Math.PI) / 180;
          const c = Math.cos(a);
          const s = Math.sin(a);
          const hw = r.w / 2;
          const hh = r.h / 2;
          const corners: [number, number][] = [
            [-hw, -hh],
            [hw, -hh],
            [hw, hh],
            [-hw, hh],
          ];
          corners.forEach(([dx, dy], i) => {
            const wx = cx + dx * c + dy * s;
            const wy = cy - dx * s + dy * c;
            if (i === 0) ctx.moveTo(this.sx(wx), this.sy(wy));
            else ctx.lineTo(this.sx(wx), this.sy(wy));
          });
          ctx.closePath();
        }
        break;
      }
      case "circle":
        ctx.arc(this.sx(shape.cx), this.sy(shape.cy), shape.r * this.camera.zoom, 0, Math.PI * 2);
        break;
      case "triangle":
        ctx.moveTo(this.sx(shape.ax), this.sy(shape.ay));
        ctx.lineTo(this.sx(shape.bx), this.sy(shape.by));
        ctx.lineTo(this.sx(shape.cx), this.sy(shape.cy));
        ctx.closePath();
        break;
    }
    ctx.fill();
    ctx.stroke();
  }

  private drawHoverLabels(objects: LevelObject[]): void {
    if (this.hovered.length === 0 || !this.mouse) return;
    const ctx = this.ctx;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "top";
    const lines = this.hovered.slice(0, 8).map((h) => {
      const o = objects.find((x) => x.index === h.index);
      const extra = o ? ` r${o.rotation}${o.flipX ? " fx" : ""}${o.flipY ? " fy" : ""}` : "";
      return `#${h.index} id ${h.id} @ ${h.x},${h.y}${extra}`;
    });
    if (this.hovered.length > 8) lines.push(`+${this.hovered.length - 8} more`);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
    const h = lines.length * 15 + 6;
    let lx = this.mouse.x + 14;
    let ly = this.mouse.y + 14;
    if (lx + w > this.width) lx = this.mouse.x - w - 6;
    if (ly + h > this.height) ly = this.mouse.y - h - 6;
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(lx, ly, w, h);
    ctx.fillStyle = "#fff";
    lines.forEach((l, i) => ctx.fillText(l, lx + 5, ly + 3 + i * 15));
  }

  private drawTrail(): void {
    if (this.trail.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = this.trail.length;
    for (let i = 0; i < n; i++) {
      const t = this.trail[(this.trailHead + i) % n];
      if (i === 0) ctx.moveTo(this.sx(t.x), this.sy(t.y));
      else ctx.lineTo(this.sx(t.x), this.sy(t.y));
    }
    ctx.stroke();
  }

  private drawPlayer(sim: Sim, which: 1 | 2, p: PlayerState): void {
    const ctx = this.ctx;
    const outer = sim.playerRect(which);
    const inner = sim.playerInnerRect(which);
    this.strokeRect(outer, p.dead ? "rgba(255,80,80,1)" : "#fff", 2);
    this.strokeRect(inner, "#f0f", 1.5);
    // Rotation tick from the centre, pointing along the sprite's "forward".
    const cx = outer.x + outer.w / 2;
    const cy = outer.y + outer.h / 2;
    const a = (p.rotation * Math.PI) / 180;
    const len = outer.w * 0.6;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.sx(cx), this.sy(cy));
    ctx.lineTo(this.sx(cx) + Math.cos(a) * len * this.camera.zoom, this.sy(cy) + Math.sin(a) * len * this.camera.zoom);
    ctx.stroke();
  }

  private strokeRect(r: Rect, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(this.sx(r.x), this.sy(r.y + r.h), r.w * this.camera.zoom, r.h * this.camera.zoom);
  }
}

function shapeContains(shape: WorldShape, x: number, y: number): boolean {
  switch (shape.type) {
    case "rect": {
      const r = shape.rect;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      let dx = x - cx;
      let dy = y - cy;
      if (shape.rotation !== 0) {
        const a = (shape.rotation * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        // Inverse of the corner transform in drawShape.
        const lx = dx * c - dy * s;
        const ly = dx * s + dy * c;
        dx = lx;
        dy = ly;
      }
      return Math.abs(dx) <= r.w / 2 && Math.abs(dy) <= r.h / 2;
    }
    case "circle": {
      const dx = x - shape.cx;
      const dy = y - shape.cy;
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    case "triangle": {
      const s1 = cross(shape.ax, shape.ay, shape.bx, shape.by, x, y);
      const s2 = cross(shape.bx, shape.by, shape.cx, shape.cy, x, y);
      const s3 = cross(shape.cx, shape.cy, shape.ax, shape.ay, x, y);
      const neg = s1 < 0 || s2 < 0 || s3 < 0;
      const pos = s1 > 0 || s2 > 0 || s3 > 0;
      return !(neg && pos);
    }
  }
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
