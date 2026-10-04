// Particle effects: the 51 Particle-Designer plists become one small file.
//
// The keys are kept exactly as cocos2d names them, so the emitter can be
// written against the documented schema rather than against a translation. The
// only processing is turning the numeric strings into numbers and checking
// that the texture each effect wants actually exists.

import { join } from "node:path";
import type { ParticleDef, ParticleFile } from "../../src/assets/miscTypes";
import { fileSize, listFiles, writeJson } from "./fsx";
import { dict, readPlist, type PlistValue } from "./plist";
import type { StepContext, StepModule, StepResult } from "./step";

/**
 * Sprite sheets and effects share the same folder, and a sheet's own sd variant
 * has no resolution suffix at all — so a name is an effect only when there is
 * no higher-resolution sibling of it and it is not an animation description.
 */
function isEffectPlist(name: string, present: ReadonlySet<string>): boolean {
  if (!name.endsWith(".plist")) return false;
  if (/-(sd|hd|uhd)\.plist$/.test(name)) return false;
  if (name.includes("_AnimDesc")) return false;
  if (name === "objectDefinitions.plist") return false;
  const base = name.slice(0, -".plist".length);
  return !present.has(`${base}-uhd.plist`) && !present.has(`${base}-hd.plist`);
}

function toDef(value: PlistValue, where: string): ParticleDef {
  const raw = dict(value, where);
  const out: ParticleDef = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (typeof v === "string") {
      const n = Number(v);
      out[key] = v.trim() !== "" && Number.isFinite(n) ? n : v;
    }
  }
  return out;
}

export const particlesStep: StepModule = {
  name: "particles",
  needs: ["sheets"],

  inputs(ctx: StepContext): string[] {
    const present = new Set(listFiles(ctx.src, (n) => n.endsWith(".plist")));
    return [...present].filter((n) => isEffectPlist(n, present)).map((n) => join(ctx.src, n));
  },

  run(ctx: StepContext): StepResult {
    const effects: Record<string, ParticleDef> = {};
    const missing = new Set<string>();
    const looseNames = new Set(listFiles(ctx.src, (n) => n.endsWith(".png")));
    const plists = new Set(listFiles(ctx.src, (n) => n.endsWith(".plist")));

    for (const file of [...plists].filter((n) => isEffectPlist(n, plists)).sort()) {
      const name = file.slice(0, -".plist".length);
      const def = toDef(readPlist(join(ctx.src, file)), name);
      const texture = def.textureFileName;
      if (typeof texture === "string") {
        const inSheets = ctx.frames?.has(texture) ?? false;
        if (!inSheets && !looseNames.has(texture)) missing.add(texture);
      }
      effects[name] = def;
    }

    const file: ParticleFile = { version: 1, effects, missingTextures: [...missing].sort() };
    let bytes = 0;
    let written = 0;
    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "particles.json"));
    } else {
      const w = writeJson(join(ctx.out, "particles.json"), file);
      bytes += w.bytes;
      if (w.written) written++;
    }
    if (missing.size > 0) {
      // Two textures really are absent from the install; the renderer falls
      // back rather than pretending the effect is broken.
      ctx.log.note(`${missing.size} particle texture(s) exist in no file: ${[...missing].join(", ")}`);
    }

    return {
      files: written,
      bytes,
      skipped: written === 0 ? 1 : 0,
      summary: `${Object.keys(effects).length} effects  ${missing.size} texture(s) missing`,
      outputs: ["particles.json"],
    };
  },
};
