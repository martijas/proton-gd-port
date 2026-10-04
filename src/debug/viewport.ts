// Pan, zoom and device-pixel handling for the asset debug pages.
//
// The level debug page has its own camera because it follows the player; this
// one is free-moving, which is what looking at a texture needs.

const ZOOM_MIN = 0.02;
const ZOOM_MAX = 32;

export class Viewport {
  /** World point shown at the centre of the canvas. */
  x = 0;
  y = 0;
  zoom = 1;
  width = 0;
  height = 0;
  dpr = 1;
  /** Cursor in canvas coordinates, or null while it is outside. */
  pointer: { x: number; y: number } | null = null;

  private dragging = false;
  private lastDrag = { x: 0, y: 0 };

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly onChange: () => void,
  ) {
    this.resize();
    window.addEventListener("resize", () => {
      this.resize();
      this.onChange();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.offsetX, e.offsetY);
        this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
        const after = this.toWorld(e.offsetX, e.offsetY);
        this.x += before.x - after.x;
        this.y += before.y - after.y;
        this.onChange();
      },
      { passive: false },
    );
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastDrag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      this.pointer = { x: e.offsetX, y: e.offsetY };
      if (this.dragging) {
        this.x -= (e.clientX - this.lastDrag.x) / this.zoom;
        this.y -= (e.clientY - this.lastDrag.y) / this.zoom;
        this.lastDrag = { x: e.clientX, y: e.clientY };
      }
      this.onChange();
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.dragging = false;
      this.onChange();
    });
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
  }

  /** Puts a w × h box fully in view with a little margin. */
  fit(w: number, h: number): void {
    this.x = w / 2;
    this.y = h / 2;
    this.zoom = clamp(Math.min(this.width / (w * 1.05), this.height / (h * 1.05)), ZOOM_MIN, ZOOM_MAX);
  }

  /** Applies the camera to a context whose transform has been reset. */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.zoom + this.x, y: (sy - this.height / 2) / this.zoom + this.y };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.width / 2, y: (wy - this.y) * this.zoom + this.height / 2 };
  }

  /** The world rectangle currently on screen. */
  visible(): { x0: number; y0: number; x1: number; y1: number } {
    const a = this.toWorld(0, 0);
    const b = this.toWorld(this.width, this.height);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
