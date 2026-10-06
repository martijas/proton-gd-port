// Recording what the player pressed, step by step, and playing it back.
//
// A recording starts with an attempt and keeps the attempt's random seed, so
// playing it back from the same start runs the same level the same way. It
// is the debug page's macro format (debug/macro.ts) at 240 steps a second, so
// one recorded here plays there and the other way round.

import { MacroPlayer, parseMacro, type Macro, type MacroInput } from "../debug/macro";
import { TICK_RATE, type PlayerInput } from "../physics/types";

export type MacroMode = "idle" | "record" | "play";

interface Held {
  jump: boolean;
  left: boolean;
  right: boolean;
}

export class MacroDeck {
  mode: MacroMode = "idle";
  /** The recording being made or played; null before the first. */
  macro: Macro | null = null;
  private player: MacroPlayer | null = null;
  private readonly held: [Held, Held] = [
    { jump: false, left: false, right: false },
    { jump: false, left: false, right: false },
  ];
  /** Set when a recording finished the level, so the next attempt does not record over it. */
  private finished = false;

  get length(): number {
    const inputs = this.macro?.inputs;
    return inputs && inputs.length > 0 ? inputs[inputs.length - 1].frame : 0;
  }

  record(): void {
    this.mode = "record";
    this.finished = false;
  }

  play(): boolean {
    if (!this.macro) return false;
    this.mode = "play";
    this.player = new MacroPlayer(this.macro);
    return true;
  }

  stop(): void {
    this.mode = "idle";
    this.player = null;
  }

  clear(): void {
    this.stop();
    this.macro = null;
  }

  /** The seed a fresh attempt should use: the recording's while playing it back. */
  seed(): number | undefined {
    return this.mode === "play" ? this.macro?.seed : undefined;
  }

  /** A fresh attempt from the start: a recording starts over, a playback goes back to its start. */
  attemptStarted(seed: number): void {
    if (this.mode === "record") {
      if (this.finished) {
        this.mode = "idle";
        return;
      }
      this.macro = { framerate: TICK_RATE, inputs: [], seed };
      this.resetHeld();
    } else if (this.mode === "play") {
      this.player?.reset();
    }
  }

  /**
   * A practice respawn at step `tick`: a recording forgets what came after
   * it, a playback winds back to it.
   */
  respawned(tick: number): void {
    if (this.mode === "record" && this.macro) {
      this.macro.inputs = this.macro.inputs.filter((i) => i.frame < tick);
      this.resetHeld();
      for (const i of this.macro.inputs) {
        const h = this.held[i.player2 ? 1 : 0];
        if (i.button === 1) h.jump = i.down;
        else if (i.button === 2) h.left = i.down;
        else h.right = i.down;
      }
    } else if (this.mode === "play" && this.player) {
      this.player.reset();
      if (tick > 0) this.player.at(tick - 1);
    }
  }

  /** The recording's buttons for step `tick`, while playing one back. */
  inputsAt(tick: number): { p1: PlayerInput; p2: PlayerInput } | null {
    return this.mode === "play" && this.player ? this.player.at(tick) : null;
  }

  /** Notes what both players' buttons did on step `tick`, while recording. */
  note(tick: number, p1: PlayerInput, p2: PlayerInput): void {
    if (this.mode !== "record" || !this.macro) return;
    this.noteOne(tick, p1, false);
    this.noteOne(tick, p2, true);
  }

  /** The level ended under a recording: it stops, keeping what it has. */
  levelFinished(): void {
    if (this.mode === "record") this.finished = true;
  }

  toJson(): string {
    return JSON.stringify(this.macro ?? { framerate: TICK_RATE, inputs: [] });
  }

  /** Loads a recording from a file's text; throws when it is not one. */
  load(text: string): void {
    this.stop();
    this.macro = parseMacro(text);
  }

  private resetHeld(): void {
    for (const h of this.held) h.jump = h.left = h.right = false;
  }

  private noteOne(tick: number, input: PlayerInput, player2: boolean): void {
    const inputs = (this.macro as Macro).inputs;
    const h = this.held[player2 ? 1 : 0];
    const push = (button: MacroInput["button"], down: boolean) => inputs.push({ frame: tick, button, player2, down });
    // A tap is the button going the other way and back inside the step: three
    // edges when it ends somewhere new, two when it ends where it started, as
    // MacroPlayer reads them.
    if (input.tap) {
      if (input.jump !== h.jump) push(1, input.jump);
      push(1, !input.jump);
      push(1, input.jump);
    } else if (input.jump !== h.jump) {
      push(1, input.jump);
    }
    h.jump = input.jump;
    if (input.left !== h.left) push(2, input.left);
    if (input.right !== h.right) push(3, input.right);
    h.left = input.left;
    h.right = input.right;
  }
}
