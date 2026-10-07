// The screen effects' fragment shader, out of the exe.
//
// Every shader trigger in the game is drawn by one program ("custom_program",
// built by ShaderLayer::setupShader from vertTest and uberShader), whose GLSL
// is a plain string inside GeometryDash.exe. Shipping the game's own source
// keeps the effects in the game's order with the game's arithmetic, where a
// hand-written copy would drift from it one guess at a time. The port turns
// the GLSL ES 1.00 into 3.00 at load (src/render/post.ts); this step only
// finds the string and checks it is the one the port expects.
//
// The vertex half is cocos2d's stock position-texture-colour shader and is not
// needed: the port draws the band with a full-screen triangle.
// [gdp ShaderLayer::setupShader, gd-ida-decomp.cpp:659230-659380; the 2.2074
//  exe carries the fragment at file offset 0x604740, the vertex at 0x604500]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ShaderLayerFile } from "../../src/assets/miscTypes";
import { fileSize, writeJson } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

/** The uniforms the port sets. A build of the game that renamed one would draw wrongly, so it fails here instead. */
export const SHADER_UNIFORMS: readonly string[] = [
  "_textureScale",
  "_textureScaleInv",
  "_screenAspect",
  "_screenAspectInv",
  "_shockWaveTime",
  "_shockWaveTime1",
  "_shockWaveTime2",
  "_shockWaveTime3",
  "_shockWaveTime4",
  "_shockWaveStrength",
  "_shockWaveWaves",
  "_shockWaveCenter",
  "_shockWaveInvert",
  "_shockWaveMinSize",
  "_shockWaveMaxSize",
  "_shockWaveMaxDistVal",
  "_shockLineTime",
  "_shockLineTime1",
  "_shockLineTime2",
  "_shockLineTime3",
  "_shockLineTime4",
  "_shockLineAxis",
  "_shockLineDirection",
  "_shockLineDual",
  "_shockLineWaves",
  "_shockLineStrength",
  "_shockLineCenter",
  "_shockLineMaxDistVal",
  "_glitchBot",
  "_glitchTop",
  "_glitchXOffset",
  "_glitchColOffset",
  "_glitchRnd",
  "_chromaticXOff",
  "_chromaticYOff",
  "_lensCircleOrigin",
  "_lensCircleStart",
  "_lensCircleEnd",
  "_lensCircleStrength",
  "_lensCircleTint",
  "_lensCircleAdditive",
  "_bulgeOrigin",
  "_bulgeValue",
  "_bulgeValue2",
  "_bulgeRadius",
  "_pinchCenterPos",
  "_pinchValue",
  "_pinchCalc1",
  "_pinchRadius",
  "_blurUseRef",
  "_blurRefColor",
  "_blurIntensity",
  "_blurFade",
  "_blurOnlyEmpty",
  "_radialBlurCenter",
  "_radialBlurValue",
  "_motionBlurValue",
  "_motionBlurMult",
  "_motionBlurDual",
  "_cGTime",
  "_cGRGBOffset",
  "_cGYOffset",
  "_cGStrength",
  "_cGHeight",
  "_cGLineStrength",
  "_cGLineThick",
  "_sepiaValue",
  "_invertColorValue",
  "_grayscaleValue",
  "_grayscaleTint",
  "_grayscaleUseLum",
  "_hueShiftCosA",
  "_hueShiftSinA",
  "_colorChangeC",
  "_colorChangeB",
  "_rowmod",
  "_colmod",
  "_rowmodCalc",
  "_colmodCalc",
  "_splitXStart",
  "_splitXRange",
  "_splitXRangeMult",
  "_splitYStart",
  "_splitYRange",
  "_splitYRangeMult",
];

/** Something only the uber shader says, to find it among the exe's other strings. */
const MARKER = "uniform float _shockWaveTime;";

function exePath(ctx: StepContext): string {
  return join(ctx.src, "..", "GeometryDash.exe");
}

/**
 * The NUL-terminated string holding `marker`, or null. Exported for the
 * tests, which hand it a small buffer rather than the exe.
 */
export function stringAround(bytes: Uint8Array, marker: string): string | null {
  const needle = Buffer.from(marker, "latin1");
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = buf.indexOf(needle);
  if (at < 0) return null;
  const start = buf.lastIndexOf(0, at) + 1;
  let end = buf.indexOf(0, at);
  if (end < 0) end = buf.length;
  return buf.toString("latin1", start, end);
}

/** The uniforms in SHADER_UNIFORMS that `source` does not declare. */
export function missingUniforms(source: string): string[] {
  return SHADER_UNIFORMS.filter((name) => !new RegExp(`uniform\\s+\\w+\\s+\\w*\\s*${name}\\s*;`).test(source));
}

export const shadersStep: StepModule = {
  name: "shaders",

  inputs(ctx: StepContext): string[] {
    const exe = exePath(ctx);
    return existsSync(exe) ? [exe] : [];
  },

  run(ctx: StepContext): StepResult {
    const rel = "shaderlayer.json";
    const dest = join(ctx.out, rel);
    if (ctx.opts.verify) {
      return { files: 0, bytes: fileSize(dest), skipped: 1, summary: "not rebuilt", outputs: [rel] };
    }
    const exe = exePath(ctx);
    if (!existsSync(exe)) throw new Error(`GeometryDash.exe is not beside the resources: ${exe}`);
    const fragment = stringAround(readFileSync(exe), MARKER);
    if (!fragment || !fragment.includes("void main()")) throw new Error("the screen-effect shader is not in the exe");
    const missing = missingUniforms(fragment);
    if (missing.length > 0) throw new Error(`the screen-effect shader has no ${missing.join(", ")}`);
    const file: ShaderLayerFile = { version: 1, fragment };
    const w = writeJson(dest, file, true);
    return {
      files: w.written ? 1 : 0,
      bytes: w.bytes,
      skipped: w.written ? 0 : 1,
      summary: `fragment shader, ${fragment.length} characters`,
      outputs: [rel],
    };
  },
};
