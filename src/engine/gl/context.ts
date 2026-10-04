// The WebGL2 context and the canvas it draws into.
//
// The context is asked for no alpha, no depth, no stencil and no multisampling:
// the renderer sorts everything on the CPU and draws back to front, so a depth
// buffer would only cost bandwidth, and an opaque drawing buffer lets the
// browser skip compositing the page behind it.

export interface GlSize {
  /** Drawing-buffer size in device pixels. */
  width: number;
  height: number;
  /** CSS pixels, which is what pointer events speak. */
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

export class GlContext {
  readonly gl: WebGL2RenderingContext;
  private lost = false;
  private size: GlSize = { width: 1, height: 1, cssWidth: 1, cssHeight: 1, dpr: 1 };
  /** Raised when the driver takes the context away; the caller has to rebuild. */
  onLost: (() => void) | null = null;
  onRestored: (() => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("This browser cannot open WebGL2.");
    this.gl = gl;

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.onRestored?.();
    });

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    // Premultiplied "over". The batcher writes an alpha of zero for an additive
    // sprite, which turns the same equation into "add", so ordinary drawing
    // never changes it. The screen-effect band (render/post.ts and
    // SpriteBatch.bandAlpha) changes it and puts it back. See spriteBatch.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.resize();
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /** Matches the drawing buffer to the canvas's CSS size. Returns true when it changed. */
  resize(maxDpr = 2): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (width === this.size.width && height === this.size.height && dpr === this.size.dpr) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.size = { width, height, cssWidth, cssHeight, dpr };
    this.gl.viewport(0, 0, width, height);
    return true;
  }

  get dimensions(): GlSize {
    return this.size;
  }

  clear(r: number, g: number, b: number): void {
    const gl = this.gl;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
