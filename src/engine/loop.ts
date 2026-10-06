import { TICK_DT, type PlayerInput } from "../physics/types";

/**
 * Fixed-step game loop: the sim always advances in whole 240 Hz ticks, the
 * renderer gets the fraction of the next tick for interpolation. Frame time
 * is clamped so a background tab does not fire thousands of ticks at once.
 */
export class GameLoop {
  private accumulator = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  /** Physics time scale (time warp trigger, slow-mo debug). */
  timeScale = 1;
  /** Never simulate more than this many seconds per frame. */
  maxFrameSeconds = 0.25;
  /** performance.now() of the last `advance`, whoever drove it. */
  lastFrameAt = 0;
  /** Frames delivered by requestAnimationFrame since `start`; a watchdog can tell whether rAF is alive. */
  rafFrames = 0;

  constructor(
    private readonly tick: () => void,
    private readonly render: (alpha: number, dtSeconds: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.rafFrames++;
      this.advance(now);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /**
   * One frame of real time. Public so an external driver (setInterval when
   * the embedding pane starves rAF) can keep the sim moving.
   */
  advance(now: number): void {
    if (!this.running) return;
    let dt = (now - this.last) / 1000;
    this.last = now;
    this.lastFrameAt = now;
    if (dt < 0) dt = 0;
    if (dt > this.maxFrameSeconds) dt = this.maxFrameSeconds;
    this.accumulator += dt * this.timeScale;
    while (this.accumulator >= TICK_DT) {
      this.tick();
      this.accumulator -= TICK_DT;
    }
    this.render(this.accumulator / TICK_DT, dt);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Runs exactly n ticks now (frame-step debugging). */
  stepTicks(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
    this.render(0, 0);
  }
}

/**
 * Keyboard/mouse/touch → a "held" boolean per player, plus whether the button
 * made a round trip between two steps, so a click shorter than a step is a
 * tap rather than lost or stretched into a one-step hold.
 */
export class InputState {
  held = false;
  held2 = false;
  /** Platformer movement (ArrowLeft/KeyA, ArrowRight/KeyD). */
  left = false;
  right = false;
  /** Jump-button edges since the last step, and where the button stood then, per player. */
  private readonly edges = [0, 0];
  private readonly stepHeld = [false, false];
  private readonly keys = new Set<string>();
  /** Called each time player 1's button goes down, for a click counter. */
  onPress: (() => void) | null = null;

  attach(target: HTMLElement | Window): void {
    const down = (e: KeyboardEvent) => {
      // Typing in a text box is not playing.
      if (e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.keys.add(e.code);
      this.sync();
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      this.sync();
    };
    const press = () => {
      this.keys.add("Pointer");
      this.sync();
    };
    const release = () => {
      this.keys.delete("Pointer");
      this.sync();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.sync();
    });
    target.addEventListener("pointerdown", press as EventListener);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  private sync(): void {
    const p1 =
      this.keys.has("Space") ||
      this.keys.has("ArrowUp") ||
      this.keys.has("KeyW") ||
      this.keys.has("Pointer");
    const p2 = this.keys.has("ArrowUp") || this.keys.has("KeyW");
    if (p1 !== this.held) this.edges[0]++;
    if (p2 !== this.held2) this.edges[1]++;
    if (p1 && !this.held) this.onPress?.();
    this.held = p1;
    this.held2 = p2;
    this.left = this.keys.has("ArrowLeft") || this.keys.has("KeyA");
    this.right = this.keys.has("ArrowRight") || this.keys.has("KeyD");
  }

  /**
   * Drops every held key. Called when a menu opens over gameplay, so a jump
   * held at that moment does not survive into the pause screen and fire again
   * the instant it closes. A tap the menu caught is dropped too; the release
   * itself still reaches the sim.
   */
  clear(): void {
    this.keys.clear();
    this.sync();
    this.edges[0] = this.held !== this.stepHeld[0] ? 1 : 0;
    this.edges[1] = this.held2 !== this.stepHeld[1] ? 1 : 0;
  }

  /** The button for this step, and whether it made a round trip since the last one. */
  private take(k: 0 | 1): { jump: boolean; tap: boolean } {
    const jump = k === 0 ? this.held : this.held2;
    const tap = this.edges[k] - (jump !== this.stepHeld[k] ? 1 : 0) >= 2;
    this.edges[k] = 0;
    this.stepHeld[k] = jump;
    return { jump, tap };
  }

  /** Player 1's button for this step; drops what either button did since the last one (the debug page calls it while a macro drives). */
  consume(): boolean {
    this.take(1);
    return this.take(0).jump;
  }

  /**
   * Full per-step input for the sim. Ask for both players every step, even
   * outside a dual, or player 2's taps pile up until the next one starts.
   */
  input(player: 1 | 2 = 1): PlayerInput {
    const b = this.take(player === 1 ? 0 : 1);
    return b.tap
      ? { jump: b.jump, tap: true, left: this.left, right: this.right }
      : { jump: b.jump, left: this.left, right: this.right };
  }
}
