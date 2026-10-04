// The audio graph, and the one thing the page has to do for itself: go quiet
// when nobody is listening.
//
// The catalog runs this in an iframe and sends no pause or mute signal, and
// hiding the pane does not stop the page — so a level left running in a hidden
// tab would keep playing its track to nobody and come back minutes out of sync.
// Everything about that is handled here rather than scattered through the
// screens, because there is exactly one right answer and it should only exist
// once.
//
//   source ─→ voice gain ─┬─→ music bus ─┐
//                         └─→ sfx bus   ─┴─→ master ─→ speakers
//
// No compressor and no reverb: the game has neither.

export interface AudioSettings {
  music: number;
  sfx: number;
}

/**
 * Waits for a promise, but not forever.
 *
 * Its own small module-level function because the thing it guards against is
 * not an error: a browser blocking autoplay may return a promise that simply
 * never settles, which no catch block will ever see. Awaiting one of those
 * during startup is indistinguishable from the game being broken.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly musicBus: GainNode;
  readonly sfxBus: GainNode;
  private muted = false;
  /** The level is paused: the context stays suspended whatever the tab does. */
  private gamePaused = false;
  private detach: (() => void) | null = null;

  constructor(settings: AudioSettings = { music: 1, sfx: 1 }) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.setVolumes(settings);
  }

  setVolumes({ music, sfx }: AudioSettings): void {
    this.musicBus.gain.value = clamp01(music);
    this.sfxBus.gain.value = clamp01(sfx);
  }

  /**
   * Brings the context up, and gives up rather than waiting forever.
   *
   * The catalog's iframe carries `allow="autoplay"`, so this usually succeeds
   * with no gesture at all. When it does not, browsers disagree about how to
   * say so: Chrome rejects, and **Firefox returns a promise that never settles**
   * until the player touches something. Awaiting that during startup hangs the
   * whole game on "Loading sound" with nothing on screen to click, which is
   * exactly what it did. So the wait is bounded, the answer is "not yet" rather
   * than an error, and `unlockOnGesture` picks it up when the player does
   * something.
   */
  async ensureRunning(timeoutMs = 1200): Promise<boolean> {
    if (this.running) return true;
    // Not while the level is paused: the pause menu's own resume does it.
    if (this.gamePaused) return false;
    try {
      await settleWithin(this.ctx.resume(), timeoutMs, undefined);
    } catch {
      return false;
    }
    return this.running;
  }

  /**
   * Resumes the context the first time the player touches anything. Harmless
   * when it is already running, and removed once it has worked.
   */
  unlockOnGesture(target: EventTarget = window): void {
    if (this.running) return;
    const tryUnlock = (): void => {
      void this.ensureRunning().then((ok) => {
        if (ok) stop();
      });
    };
    const stop = (): void => {
      target.removeEventListener("pointerdown", tryUnlock);
      target.removeEventListener("keydown", tryUnlock);
      target.removeEventListener("touchstart", tryUnlock);
    };
    target.addEventListener("pointerdown", tryUnlock);
    target.addEventListener("keydown", tryUnlock);
    target.addEventListener("touchstart", tryUnlock);
  }

  get running(): boolean {
    // Read through a widened type: TypeScript narrows `ctx.state` across the
    // await above and then decides "running" is impossible, which it is not.
    return (this.ctx.state as string) === "running";
  }

  /** Fades the whole graph rather than cutting it, so a tab switch is not a click. */
  private ramp(to: number, seconds: number): void {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(to, now + seconds);
  }

  /**
   * The pause menu: everything stops where it is, as the game pauses its
   * channels, and carries on from there on the way out. A sound started in
   * between (the menu's own) waits for the way out.
   * [gdp PlayLayer::pauseGame → pauseAudio :93469; resume → resumeAllAudio :93525]
   */
  pauseGame(): void {
    this.gamePaused = true;
    void this.ctx.suspend();
  }

  resumeGame(): void {
    if (!this.gamePaused) return;
    this.gamePaused = false;
    void this.ensureRunning();
  }

  mute(): void {
    if (this.muted) return;
    this.muted = true;
    this.ramp(0, 0.08);
  }

  unmute(): void {
    if (!this.muted) return;
    this.muted = false;
    this.ramp(1, 0.08);
  }

  /**
   * Wires the page lifecycle. `onHidden`/`onVisible` let the caller stop and
   * restart the simulation as well — a hidden pane still gets the occasional
   * animation frame, and the loop's own clamp only limits one frame's worth, so
   * without this a backgrounded level quietly advances a quarter second at a
   * time.
   */
  attachLifecycle(hooks: { onHidden?: () => void; onVisible?: () => void; onLeave?: () => void } = {}): void {
    this.detach?.();
    const visibility = (): void => {
      if (document.visibilityState === "hidden") {
        hooks.onHidden?.();
        void this.ctx.suspend();
      } else {
        void this.ensureRunning();
        hooks.onVisible?.();
      }
    };
    // Losing focus while still on screen is different: the pane is visible, so
    // the picture should keep up, but the sound is someone else's now.
    const blur = (): void => this.mute();
    const focus = (): void => this.unmute();
    const leave = (): void => {
      hooks.onLeave?.();
      void this.ctx.close();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("pagehide", leave);
    this.detach = () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pagehide", leave);
    };
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    void this.ctx.close();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
