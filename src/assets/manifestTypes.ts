// The shape of assets/manifest.json: what the build produced, so the runtime
// can size a loading bar, pick a resolution and know what exists before asking
// for it.

import type { IconKind } from "./iconTypes";

export interface ManifestChecks {
  framesIndexed: number;
  objects: number;
  censusIds: number;
  /** Frames the object table asked for that no sheet contains. Zero, or the build failed. */
  missingFrames: number;
  /** Glow names the old reference table invented that the game does not have. */
  droppedGlow: number;
}

export interface Manifest {
  version: 1;
  /** ISO timestamp; also a handle for cache busting. */
  generated: string;
  generator: { tool: string; options: Record<string, unknown> };
  source: { root: string; files: number; bytes: number };
  res: {
    /** Sheet resolutions present, best first. */
    atlas: string[];
    icons: string;
    /** What to use unless the device says otherwise. */
    preferred: string;
  };
  /** Every shipped path under assets/, with its size in bytes. */
  files: Record<string, number>;
  categories: Record<string, { files: number; bytes: number }>;
  totals: { files: number; bytes: number; warnBytes: number; failBytes: number; headroomBytes: number };
  /** What exists, so nothing fetches a 404. */
  have: {
    levels: number[];
    backgrounds: number[];
    grounds: number[];
    foregrounds: number[];
    fonts: string[];
    icons: Record<IconKind, number[]>;
    particles: string[];
    animEntities: string[];
    audio: { music: string[]; sfx: string[]; songs: string[] };
  };
  checks: ManifestChecks;
}
