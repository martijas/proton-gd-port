// Incremental state for the asset build, kept in data/asset-build.json.
//
// A step is skipped when its tool sources, its options and every one of its
// inputs are unchanged and all of its recorded outputs still exist. The output
// list doubles as the prune list: the catalog folder is built with
// emptyOutDir off, so nothing else ever removes a file that stopped being
// produced.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { removePath, stampOf, writeJson } from "./fsx";

export interface StepState {
  toolHash: string;
  optsHash: string;
  /** Absolute input path → [mtimeMs, size]. */
  inputs: Record<string, [number, number]>;
  /** Output paths relative to the assets root. */
  outputs: string[];
}

export interface BuildManifest {
  version: 1;
  steps: Record<string, StepState>;
}

const EMPTY: BuildManifest = { version: 1, steps: {} };

export function loadManifest(path: string): BuildManifest {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BuildManifest;
    if (parsed.version !== 1 || typeof parsed.steps !== "object") return structuredClone(EMPTY);
    return parsed;
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveManifest(path: string, manifest: BuildManifest): void {
  writeJson(path, manifest, true);
}

export function stampInputs(paths: string[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const p of paths) {
    const s = stampOf(p);
    out[p.replace(/\\/g, "/")] = s ? [Math.round(s.mtimeMs), s.size] : [0, -1];
  }
  return out;
}

export interface StaleCheck {
  stale: boolean;
  reason: string;
}

export function isStale(
  manifest: BuildManifest,
  step: string,
  toolHash: string,
  optsHash: string,
  inputs: Record<string, [number, number]>,
  assetsRoot: string,
): StaleCheck {
  const prev = manifest.steps[step];
  if (!prev) return { stale: true, reason: "first run" };
  if (prev.toolHash !== toolHash) return { stale: true, reason: "generator changed" };
  if (prev.optsHash !== optsHash) return { stale: true, reason: "options changed" };
  const prevKeys = Object.keys(prev.inputs);
  const nextKeys = Object.keys(inputs);
  if (prevKeys.length !== nextKeys.length) return { stale: true, reason: "input set changed" };
  for (const k of nextKeys) {
    const a = prev.inputs[k];
    const b = inputs[k];
    if (!a || a[0] !== b[0] || a[1] !== b[1]) return { stale: true, reason: `changed: ${k}` };
  }
  for (const rel of prev.outputs) {
    if (!existsSync(join(assetsRoot, rel))) return { stale: true, reason: `missing output: ${rel}` };
  }
  return { stale: false, reason: "up to date" };
}

/** Records what a step produced, so the next run can skip it and prune around it. */
export function recordStep(
  manifest: BuildManifest,
  step: string,
  state: { toolHash: string; optsHash: string; inputs: Record<string, [number, number]>; outputs: string[] },
): void {
  manifest.steps[step] = {
    toolHash: state.toolHash,
    optsHash: state.optsHash,
    inputs: state.inputs,
    outputs: [...new Set(state.outputs)].sort(),
  };
}

/** Removes the paths a previous run produced that this one did not. */
export function pruneAgainst(assetsRoot: string, previous: BuildManifest, next: BuildManifest): string[] {
  const claimed = new Set<string>();
  for (const step of Object.values(next.steps)) for (const rel of step.outputs) claimed.add(rel);
  const removed: string[] = [];
  for (const [name, step] of Object.entries(previous.steps)) {
    if (!next.steps[name]) continue;
    for (const rel of step.outputs) {
      if (claimed.has(rel)) continue;
      const full = resolve(assetsRoot, rel);
      if (!existsSync(full)) continue;
      removePath(full);
      removed.push(rel);
    }
  }
  return removed;
}
