// The 27 official levels, copied with their trailing rubbish removed.
//
// The install's files are not uniformly terminated: some end clean, some with a
// NUL byte, some with a newline. The decoder skips characters outside the
// base64 alphabet anyway, but trimming here means the shipped files are exactly
// the level string and nothing else.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileSize, writeIfChanged } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

/** 1–22, The Challenge, and the four Tower floors. */
export const LEVEL_IDS: readonly number[] = [...Array.from({ length: 22 }, (_, i) => i + 1), 3001, 5001, 5002, 5003, 5004];

export const levelsStep: StepModule = {
  name: "levels",

  inputs(ctx: StepContext): string[] {
    return LEVEL_IDS.map((id) => join(ctx.src, "levels", `${id}.txt`));
  },

  run(ctx: StepContext): StepResult {
    const outputs: string[] = [];
    let bytes = 0;
    let written = 0;
    let trimmed = 0;

    for (const id of LEVEL_IDS) {
      const src = join(ctx.src, "levels", `${id}.txt`);
      const rel = `levels/${id}.txt`;
      // latin1 so a stray byte survives the round trip instead of becoming U+FFFD.
      const raw = readFileSync(src, "latin1");
      const clean = raw.replace(/[\s\0]+$/, "");
      if (clean.length !== raw.length) trimmed++;
      if (!ctx.opts.verify) {
        const w = writeIfChanged(join(ctx.out, rel), Buffer.from(clean, "latin1"));
        bytes += w.bytes;
        if (w.written) written++;
      } else {
        bytes += fileSize(join(ctx.out, rel));
      }
      outputs.push(rel);
    }

    return {
      files: written,
      bytes,
      skipped: outputs.length - written,
      summary: `${LEVEL_IDS.length} levels  ${trimmed} trimmed`,
      outputs,
    };
  },
};
