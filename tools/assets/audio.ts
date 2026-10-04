// Music and sound effects, copied as they are.
//
// These are most of the folder's bytes, and they shipped for the first time
// with the audio goal. `--no-audio` leaves them out; the flag is part of the
// step's identity, so switching it off again prunes them.
//
// No transcode by default either. The sound effects are Ogg Vorbis, which
// every browser except Safari plays; `--transcode` writes an m4a beside each
// one for that case, and the manifest records which codecs a file has.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { copyIfChanged, ensureDir, fileSize, listFiles } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

interface Bucket {
  /** Folder inside the install, "" for its root. */
  from: string;
  /** Folder under assets/audio/. */
  to: string;
  ext: ".mp3" | ".ogg";
}

const BUCKETS: Bucket[] = [
  { from: "", to: "music", ext: ".mp3" },
  { from: "", to: "sfx", ext: ".ogg" },
  { from: "sfx", to: "sfx", ext: ".ogg" },
  { from: "songs", to: "songs", ext: ".ogg" },
];

function filesIn(ctx: StepContext, bucket: Bucket): string[] {
  const dir = bucket.from === "" ? ctx.src : join(ctx.src, bucket.from);
  return listFiles(dir, (n) => n.toLowerCase().endsWith(bucket.ext)).map((n) => join(dir, n));
}

export const audioStep: StepModule = {
  name: "audio",
  optionKeys: ["audio", "transcode"],

  inputs(ctx: StepContext): string[] {
    if (!ctx.opts.audio) return [];
    return BUCKETS.flatMap((b) => filesIn(ctx, b));
  },

  run(ctx: StepContext): StepResult {
    if (!ctx.opts.audio) {
      return { files: 0, bytes: 0, skipped: 1, summary: "not shipped (--no-audio)", outputs: [] };
    }
    const outputs: string[] = [];
    let bytes = 0;
    let copied = 0;
    let transcoded = 0;

    const jobs: { src: string; to: string; ext: ".mp3" | ".ogg" }[] = [];
    for (const bucket of BUCKETS) {
      for (const src of filesIn(ctx, bucket)) jobs.push({ src, to: bucket.to, ext: bucket.ext });
    }

    for (const job of jobs) {
      const name = basename(job.src);
      const rel = `audio/${job.to}/${name}`;
      if (!ctx.opts.verify) {
        const c = copyIfChanged(job.src, join(ctx.out, rel));
        bytes += c.bytes;
        if (c.copied) copied++;
      } else {
        bytes += fileSize(join(ctx.out, rel));
      }
      outputs.push(rel);

      if (ctx.opts.transcode && job.ext === ".ogg" && !ctx.opts.verify) {
        const m4a = rel.replace(/\.ogg$/i, ".m4a");
        const dest = join(ctx.out, m4a);
        if (!existsSync(dest)) {
          ensureDir(join(ctx.out, `audio/${job.to}`));
          try {
            execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", job.src, "-c:a", "aac", "-b:a", "128k", dest]);
            transcoded++;
          } catch {
            ctx.log.warn(`ffmpeg could not convert ${name}`);
          }
        }
        bytes += fileSize(dest);
        outputs.push(m4a);
      }
    }

    return {
      files: copied + transcoded,
      bytes,
      skipped: outputs.length - copied - transcoded,
      summary: `${outputs.length} files${transcoded > 0 ? `  ${transcoded} converted` : ""}`,
      outputs,
    };
  },
};
