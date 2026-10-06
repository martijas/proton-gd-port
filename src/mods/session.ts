// What the status lines count: frames, clicks, the best run of the visit,
// and how often noclip kept the player alive.

import type { Sim } from "../physics/types";
import { wholePercent } from "../ui/screens/play";

export interface Run {
  from: number;
  to: number;
}

export class Session {
  readonly startedAt = performance.now();
  private readonly clicks: number[] = [];
  /** Clicks since the attempt started. */
  attemptClicks = 0;
  private frames = 0;
  private frameWindowAt = performance.now();
  fps = 0;
  /** The visit's longest run, start to end in whole percent. */
  bestRun: Run | null = null;
  private runFrom = 0;
  private runOver = false;
  private noclipBaseTick = 0;
  private noclipBaseHits = 0;
  private lastHits = 0;
  private hitLastTick = false;
  /** Separate stretches of the attempt noclip kept the player alive through. */
  noclipDeaths = 0;
  /** Set on a step noclip saved the player in, for the flash; read and cleared by the overlay. */
  noclipHitNow = false;

  /** A press of player 1's button, from the page. */
  click(now = performance.now()): void {
    this.clicks.push(now);
    this.attemptClicks++;
  }

  cps(now = performance.now()): number {
    while (this.clicks.length > 0 && this.clicks[0] < now - 1000) this.clicks.shift();
    return this.clicks.length;
  }

  frame(now = performance.now()): void {
    this.frames++;
    const span = now - this.frameWindowAt;
    if (span >= 500) {
      this.fps = Math.round((this.frames * 1000) / span);
      this.frames = 0;
      this.frameWindowAt = now;
    }
  }

  /** A fresh attempt from the start. */
  attemptStarted(sim: Sim): void {
    this.attemptClicks = 0;
    this.noclipBaseTick = sim.tick;
    this.noclipBaseHits = sim.noclipHits;
    this.lastHits = sim.noclipHits;
    this.hitLastTick = false;
    this.noclipDeaths = 0;
    this.runFrom = wholePercent(sim.progress());
    this.runOver = false;
  }

  /** A practice respawn: the run starts again from the checkpoint; noclip's count carries on. */
  respawned(sim: Sim): void {
    this.runFrom = wholePercent(sim.progress());
    this.runOver = false;
  }

  /** After every step. */
  stepped(sim: Sim): void {
    const hits = sim.noclipHits;
    const hit = hits > this.lastHits;
    if (hit && !this.hitLastTick) this.noclipDeaths++;
    if (hit) this.noclipHitNow = true;
    this.hitLastTick = hit;
    this.lastHits = hits;
    if (!this.runOver && (sim.state.dead || sim.state.finished)) {
      this.runOver = true;
      const to = sim.state.finished ? 100 : wholePercent(sim.progress());
      const best = this.bestRun;
      if (!best || to - this.runFrom > best.to - best.from) this.bestRun = { from: this.runFrom, to };
    }
  }

  /** The share of this attempt's steps noclip did not have to save, 0 to 100. */
  noclipAccuracy(sim: Sim): number {
    const ticks = sim.tick - this.noclipBaseTick;
    if (ticks <= 0) return 100;
    return Math.max(0, 100 * (1 - (sim.noclipHits - this.noclipBaseHits) / ticks));
  }

  levelEntered(): void {
    this.bestRun = null;
  }
}
