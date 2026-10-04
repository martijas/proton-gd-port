// The shape every build step shares. Kept in its own module so the step
// modules and the orchestrator can import it without a cycle.

import type { BuildOptions } from "./config";
import type { BuildManifest } from "./manifest";
import type { Logger } from "./log";

/** Frame name → where it lives, built by the sheets step and read by everyone after. */
export interface FrameIndex {
  /** Resolution the index was built at. */
  res: string;
  /** Frame name → "<sheet>" it belongs to. */
  sheetOf: Map<string, string>;
  has(name: string): boolean;
  size: number;
}

export interface StepContext {
  /** The real install, read-only. */
  readonly src: string;
  /** The catalog folder's assets/ directory. */
  readonly out: string;
  /** games-src/geometrydash/data */
  readonly data: string;
  readonly opts: BuildOptions;
  readonly manifest: BuildManifest;
  readonly log: Logger;
  /** Populated by the sheets step; later steps validate frame names through it. */
  frames: FrameIndex | null;
  /** Anything a step wants a later step to read, keyed by step name. */
  readonly shared: Map<string, unknown>;
}

export interface StepResult {
  /** Files written or copied (not counting skipped ones). */
  files: number;
  /** Bytes of everything this step is responsible for in assets/. */
  bytes: number;
  /** Outputs left untouched because they were already current. */
  skipped: number;
  /** One line for the console, e.g. "41 atlases  8753 frames". */
  summary: string;
  /** Paths relative to assets/, for the manifest and the prune pass. */
  outputs: string[];
}

export interface StepModule {
  readonly name: string;
  /** Steps that must run first; pulled in automatically by --only. */
  readonly needs?: readonly string[];
  /** Source files this step reads. Drives the dry-run plan and staleness. */
  inputs(ctx: StepContext): string[];
  /**
   * Run every time, never skipped. For a step that describes the built folder
   * rather than reading the install: its real input is what the other steps
   * just wrote, which no stamp of the source art can see.
   */
  readonly always?: boolean;
  /**
   * Files outside tools/ that this step's output depends on, relative to the
   * project root. A step that reads a hand-written table in src/ has to say so,
   * or editing that table leaves the step looking up to date.
   */
  readonly sources?: readonly string[];
  /** Option fields that invalidate this step's outputs when they change. */
  optionKeys?: readonly (keyof BuildOptions)[];
  /**
   * Called instead of run() when the step is up to date. Later steps still
   * need whatever this one shares (the frame index, for instance), so it is
   * rebuilt from the files already on disk rather than from the source art.
   */
  prepare?(ctx: StepContext): void | Promise<void>;
  run(ctx: StepContext): Promise<StepResult> | StepResult;
}

export function emptyResult(summary = "nothing to do"): StepResult {
  return { files: 0, bytes: 0, skipped: 0, summary, outputs: [] };
}
