// A saved autoplayer run, and replaying it tick by tick.
//
// Shared by the level debug page and the macro viewer, which both play one of
// test/macros/<id>.json back through the same simulation the tests replay.

import { TICK_RATE, type PlayerInput } from "../physics/types";

export interface MacroInput {
  frame: number;
  /** 1 = jump, 2 = left, 3 = right. */
  button: 1 | 2 | 3;
  player2: boolean;
  down: boolean;
}

export interface Macro {
  framerate: number;
  inputs: MacroInput[];
  /** The random seed the run was recorded with, when it is not the default. */
  seed?: number;
}

/** Replays a recorded input list tick by tick; `at(tick)` must be called with non-decreasing ticks. */
export class MacroPlayer {
  private cursor = 0;
  private readonly p1: PlayerInput = { jump: false, left: false, right: false };
  private readonly p2: PlayerInput = { jump: false, left: false, right: false };
  private readonly inputs: MacroInput[];

  constructor(macro: Macro) {
    const scale = TICK_RATE / (macro.framerate > 0 ? macro.framerate : TICK_RATE);
    this.inputs = macro.inputs
      .map((i) => ({ ...i, frame: Math.round(i.frame * scale) }))
      .sort((a, b) => a.frame - b.frame);
  }

  get length(): number {
    return this.inputs.length ? this.inputs[this.inputs.length - 1].frame : 0;
  }

  reset(): void {
    this.cursor = 0;
    for (const p of [this.p1, this.p2]) p.jump = p.left = p.right = false;
  }

  /**
   * The inputs for `tick`. A jump button that went down and up (or up and
   * down) on the same tick comes out as a tap, which the sim runs as two
   * commands in one step, as the game does.
   */
  at(tick: number): { p1: PlayerInput; p2: PlayerInput } {
    const was1 = this.p1.jump;
    const was2 = this.p2.jump;
    let edges1 = 0;
    let edges2 = 0;
    while (this.cursor < this.inputs.length && this.inputs[this.cursor].frame <= tick) {
      const i = this.inputs[this.cursor++];
      const p = i.player2 ? this.p2 : this.p1;
      if (i.button === 1) {
        if (p.jump !== i.down) {
          if (i.player2) edges2++;
          else edges1++;
        }
        p.jump = i.down;
      } else if (i.button === 2) p.left = i.down;
      else p.right = i.down;
    }
    const tap1 = edges1 - (this.p1.jump !== was1 ? 1 : 0) >= 2;
    const tap2 = edges2 - (this.p2.jump !== was2 ? 1 : 0) >= 2;
    return { p1: tap1 ? { ...this.p1, tap: true } : { ...this.p1 }, p2: tap2 ? { ...this.p2, tap: true } : { ...this.p2 } };
  }
}

export function parseMacro(text: string): Macro {
  const json = JSON.parse(text) as unknown;
  if (typeof json !== "object" || json === null) throw new Error("not an object");
  const obj = json as { framerate?: unknown; inputs?: unknown; seed?: unknown };
  if (!Array.isArray(obj.inputs)) throw new Error("no inputs array");
  const inputs: MacroInput[] = [];
  for (const raw of obj.inputs as unknown[]) {
    const r = raw as Partial<Record<keyof MacroInput, unknown>>;
    const button = Number(r.button);
    if (button !== 1 && button !== 2 && button !== 3) continue;
    inputs.push({
      frame: Number(r.frame) || 0,
      button,
      player2: Boolean(r.player2),
      down: Boolean(r.down),
    });
  }
  const seed = typeof obj.seed === "number" && Number.isFinite(obj.seed) ? obj.seed : undefined;
  return { framerate: Number(obj.framerate) || TICK_RATE, inputs, ...(seed !== undefined ? { seed } : {}) };
}
