// The screen effects: what the shader triggers do to the one layer they all
// talk to, which part of the scene that layer reaches, and the colour
// arithmetic of the game's own shader. All of it runs without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AtlasSet } from "../src/assets/atlas";
import type { AtlasFile } from "../src/assets/atlasTypes";
import type { ObjectRecord } from "../src/assets/objectTypes";
import type { ShaderLayerFile } from "../src/assets/miscTypes";
import type { LevelObject } from "../src/level/types";
import { NO_INPUT } from "../src/physics/types";
import { ColorTable } from "../src/render/colors";
import { DrawList } from "../src/render/drawList";
import { batchZ, PARENT_MODE, slotOfZ } from "../src/render/batchNodes";
import { bandUniforms, toGlsl300, type BandScene } from "../src/render/post";
import { statusOf } from "../src/triggers/registry";
import {
  applyColourTail,
  applyShaderTrigger,
  backgroundSide,
  bandZ,
  carriedShaderState,
  colourUniforms,
  createShaderState,
  effectiveZLayer,
  effectiveZOrder,
  groundSide,
  layerOfPart,
  LAYER_Z,
  maxZOrder,
  middlegroundSide,
  minZOrder,
  OBJECT_Z,
  objectSide,
  partSide,
  SCENE_PART,
  SCENE_PARTS,
  sceneOrder,
  SHADER_LAYER,
  SHADER_TRIGGER_IDS,
  shaderActive,
  stepShaderState,
  TWEEN,
  type ColourUniforms,
  type ShaderState,
} from "../src/triggers/shaderState";
import { parseTrigger, type TriggerSpec } from "../src/triggers/spec";
import { missingUniforms, SHADER_UNIFORMS, stringAround } from "../tools/assets/shaders";
import { LEVELS_DIR, loadOfficialLevel, makeSim, builtPath } from "./helpers";
import { buildLevel, emptyLevel, makeHeader, STANDING_Y } from "./levelKit";

const LEVELS = existsSync(`${LEVELS_DIR}/1.txt`) ? false : "needs the real install";
const SHADER_ASSET = builtPath("assets/shaderlayer.json");
const NO_SHADER = existsSync(SHADER_ASSET) ? false : "run `npm run assets` first";

/** A shader trigger with these keys, as the level decoder would hand it over. */
function trigger(id: number, props: Record<number, string | number> = {}): TriggerSpec {
  const raw: Record<number, string> = {};
  for (const [k, v] of Object.entries(props)) raw[Number(k)] = String(v);
  return parseTrigger(buildLevel([{ id, x: 0, y: 0, props: raw }]).objects[0]);
}

function fire(st: ShaderState, id: number, props: Record<number, string | number> = {}): void {
  applyShaderTrigger(st, trigger(id, props));
}

function near(got: number, want: number, what: string, tolerance = 1e-5): void {
  assert.ok(Math.abs(got - want) < tolerance, `${what}: got ${got}, want ${want}`);
}

function nearAll(got: readonly number[], want: readonly number[], what: string, tolerance = 1e-5): void {
  assert.equal(got.length, want.length, what);
  got.forEach((g, i) => near(g, want[i], `${what}[${i}]`, tolerance));
}

const WHITE = (): { r: number; g: number; b: number } => ({ r: 255, g: 255, b: 255 });

function invertOf(st: ShaderState): number[] {
  return [...colourUniforms(st, WHITE).invert];
}

// --- the layer range ---------------------------------------------------------

test("the setup trigger's range: absent or garbage is the whole scene, Disable All resets it", () => {
  // 0xCDCDCDCD in 196/197 is uninitialised memory the editor saved; below 1
  // is 1 and 0 or less is 15. Disable All runs after the range, so it always
  // ends at 1..15. [ShaderLayer::updateZLayer :659623-659645;
  //  triggerShaderCommand :422289-422297]
  const st = createShaderState();
  fire(st, 2904, { 196: "-842150451", 197: "-842150451" });
  assert.deepEqual([st.layerMin, st.layerMax], [1, 15]);
  fire(st, 2904, { 197: 12 });
  assert.deepEqual([st.layerMin, st.layerMax], [1, 12]);
  fire(st, 2904, { 196: 8, 197: 8, 188: 1 });
  assert.deepEqual([st.layerMin, st.layerMax, st.noPlayerParticles], [8, 8, true]);
  fire(st, 2904, { 192: 1, 197: 14 });
  assert.deepEqual([st.layerMin, st.layerMax, st.noPlayerParticles], [1, 15, false]);
});

test("the z bounds of each layer are the exe's table", () => {
  // [minZOrderForShaderZ, 2.2074 jump table at VA 0x140223700;
  //  maxZOrderForShaderZ :422638-422672]
  assert.deepEqual(
    Array.from({ length: 15 }, (_, i) => minZOrder(i + 1)),
    [-1600, -1600, -1500, -1200, -900, -600, -300, 39, 100, 400, 700, 1000, 1400, 1400, 1400],
  );
  assert.deepEqual(
    Array.from({ length: 15 }, (_, i) => maxZOrder(i + 1)),
    [-1600, -1600, -1201, -901, -601, -301, 38, 61, 399, 699, 999, 1399, 1399, 1399, 1400],
  );
  assert.equal(minZOrder(0), 0);
  assert.equal(maxZOrder(16), 0);
});

test("which side of the band each part of the scene falls on", () => {
  // [GJBaseGameLayer::updateShaderLayer :424782-424939]
  const range = (min: number, max: number, noParticles = false): ShaderState => {
    const st = createShaderState();
    fire(st, 2904, noParticles ? { 196: min, 197: max, 188: 1 } : { 196: min, 197: max });
    return st;
  };
  const sides = (st: ShaderState, zs: number[]): number[] => zs.map((z) => objectSide(z, st));

  // Dash's own, at x = 945: the player and nothing else, not even its particles.
  let st = range(8, 8, true);
  assert.deepEqual(bandZ(st), { lo: 40, hi: 60 });
  assert.deepEqual(sides(st, [-1400, -3, 39, 40, 59, 61, 200]), [-1, -1, -1, 0, 0, 1, 1]);
  assert.deepEqual([backgroundSide(st), middlegroundSide(st), groundSide(st)], [-1, -1, 1]);

  st = range(8, 8);
  assert.deepEqual(bandZ(st), { lo: 39, hi: 61 });
  assert.deepEqual(sides(st, [39, 61, -3]), [0, 0, -1]);

  st = range(1, 15);
  assert.deepEqual(sides(st, [-1400, -3, 59, 1100]), [0, 0, 0, 0]);
  assert.deepEqual([backgroundSide(st), middlegroundSide(st), groundSide(st)], [0, 0, 0]);

  st = range(1, 12);
  assert.equal(bandZ(st).hi, 1399);
  assert.equal(objectSide(1100, st), 0);
  assert.equal(groundSide(st), 1, "BG to T4 leaves the ground alone");

  st = range(1, 10);
  assert.equal(bandZ(st).hi, 699);
  assert.deepEqual(sides(st, [500, 800]), [0, 1]);
  assert.equal(groundSide(st), 1);

  st = range(2, 5);
  assert.deepEqual(bandZ(st), { lo: -1600, hi: -601 });
  assert.deepEqual(sides(st, [-1400, -800, -500]), [0, 0, 1]);
  assert.deepEqual([backgroundSide(st), middlegroundSide(st), groundSide(st)], [-1, 0, 1]);

  st = range(13, 13);
  assert.deepEqual(bandZ(st), { lo: 1400, hi: 1399 });
  assert.equal(objectSide(1100, st), -1);
  assert.deepEqual([backgroundSide(st), groundSide(st)], [-1, 0], "the ground alone");
});

test("the scene draws below the band, then the band, then above it, whatever order the sides come in", () => {
  // updateZLayer clamps only a minimum under 1 and a maximum of 0 or less,
  // so a 196 or 197 past 15 reaches the band tests, where maxZOrder(16) is 0.
  // [updateZLayer :659623-659645; updateShaderLayer :424782-424939]
  const order = new Uint8Array(SCENE_PARTS);
  const sides = new Int8Array(SCENE_PARTS);
  let combinations = 0;
  let reordered = 0;
  for (let min = -1; min <= 16; min++) {
    for (let max = -1; max <= 16; max++) {
      for (const noParticles of [false, true]) {
        const st = createShaderState();
        fire(st, 2904, noParticles ? { 196: min, 197: max, 188: 1 } : { 196: min, 197: max });
        sceneOrder(st, order, sides);
        const what = `196 = ${min}, 197 = ${max}${noParticles ? ", 188" : ""}`;
        assert.deepEqual([...order].sort((a, b) => a - b), every(SCENE_PARTS), `${what}: every part once`);
        for (let i = 0; i < SCENE_PARTS; i++) {
          assert.equal(sides[i], partSide(order[i], st), `${what}: part ${order[i]}'s side`);
          if (i === 0) continue;
          assert.ok(sides[i] >= sides[i - 1], `${what}: below, then the band, then above`);
          if (sides[i] === sides[i - 1]) assert.ok(order[i] > order[i - 1], `${what}: the plain order within a side`);
        }
        const plain = order.every((part, i) => part === i);
        if (min <= 15 && max <= 15) assert.ok(plain, `${what}: short of 16 the sides already run in the plain order`);
        if (!plain) reordered++;
        combinations++;
      }
    }
  }
  assert.equal(combinations, 648);
  assert.ok(reordered > 0, "past 15 some do not");

  // BG to 16: the band stops below the player but takes the ground, which
  // then lies under the player and T1 to T4 rather than over them.
  const st = createShaderState();
  fire(st, 2904, { 196: 1, 197: 16 });
  sceneOrder(st, order, sides);
  assert.deepEqual([partSide(SCENE_PART.GROUND, st), partSide(SCENE_PART.PLAYER, st), partSide(SCENE_PART.FRONT, st)], [0, 1, 1]);
  const at = (part: number): number => order.indexOf(part);
  assert.ok(at(SCENE_PART.GROUND) < at(SCENE_PART.PLAYER), "the ground before the player");
  assert.ok(at(SCENE_PART.GROUND) < at(SCENE_PART.FRONT), "and before T1");
});

test("the scene's parts are the batch layers with the player's things between B1 and T1", () => {
  assert.deepEqual(every(SCENE_PARTS).map(layerOfPart), [-1, -1, 0, 1, 2, 3, 4, -1, -1, -1, -1, 5, 6, 7, 8, -1]);
  // Dash's range, part by part, as the side functions give it.
  const st = createShaderState();
  fire(st, 2904, { 196: 8, 197: 8, 188: 1 });
  assert.equal(partSide(SCENE_PART.BACKGROUND, st), backgroundSide(st));
  assert.equal(partSide(SCENE_PART.MIDDLEGROUND, st), middlegroundSide(st));
  assert.equal(partSide(SCENE_PART.GROUND, st), groundSide(st));
  assert.equal(partSide(SCENE_PART.PLAYER, st), objectSide(OBJECT_Z.PLAYER, st));
  assert.equal(partSide(SCENE_PART.PARTICLES_UNDER, st), objectSide(OBJECT_Z.PARTICLES_UNDER, st));
  assert.equal(partSide(SCENE_PART.BEHIND + 4, st), objectSide(LAYER_Z[4], st));
  assert.deepEqual(
    every(SCENE_PARTS).map((part) => partSide(part, st)),
    [-1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 1, 1, 1, 1, 1, 1],
    "the player alone in the band",
  );
});

test("the Ghost Trail's copies sit just under the player, on its side of every band", () => {
  // trailSnapshot adds each copy at the PlayerObject's z less one, so a
  // gradient on B1 or the particles under the player never cover them.
  // [GhostTrailEffect::trailSnapshot :59230-59233, :59276-59281;
  //  toggleGhostEffect :147158 (+296 the player); createPlayer :417928-417931]
  assert.equal(OBJECT_Z.GHOST, OBJECT_Z.PLAYER - 1);
  assert.ok(OBJECT_Z.GHOST > maxZOrder(SHADER_LAYER.B1) + 5, "over B1's gradients at any z order");
  assert.ok(OBJECT_Z.GHOST > OBJECT_Z.PARTICLES_UNDER && OBJECT_Z.GHOST > OBJECT_Z.SPIDER_DASH);
  // The renderer draws them with the player, so no band may part them.
  for (let min = -1; min <= 16; min++) {
    for (let max = -1; max <= 16; max++) {
      for (const noParticles of [false, true]) {
        const st = createShaderState();
        fire(st, 2904, noParticles ? { 196: min, 197: max, 188: 1 } : { 196: min, 197: max });
        assert.equal(objectSide(OBJECT_Z.GHOST, st), partSide(SCENE_PART.PLAYER, st), `196 = ${min}, 197 = ${max}${noParticles ? ", 188" : ""}`);
      }
    }
  }
});

function every(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

test("an object's key-24 layer lands in the batch layer the game parents it to", () => {
  // Where a plain GJ_GameSheet sprite's batch falls, and an additive one's
  // on layer 4, which is B1's top for what blends and T1 for what does not.
  // [GJBaseGameLayer::parentForZLayer :435785-436250; getObjectZLayer
  //  :169016-169023 — zero is "the object's own"]
  const slot = (zl: number, blend = false): number => slotOfZ(batchZ(zl, blend, PARENT_MODE.GAME));
  assert.deepEqual([-5, -3, -1, 1, 3, 5, 7, 9, 11].map((zl) => slot(zl)), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([-4, -2, 0, 2, 6, 8, 10, 12].map((zl) => slot(zl)), [1, 2, 3, 4, 6, 7, 8, 8]);
  assert.deepEqual([slot(4, true), slot(4)], [4, 5], "layer 4");
  assert.ok(LAYER_Z[4] < -5 && LAYER_Z[4] > -300, "B1 is behind the player and inside B1's own range");
  assert.ok(LAYER_Z[5] >= 100 && LAYER_Z[5] < 400, "T1 is in front of it");
  assert.equal(effectiveZLayer(0, 5), 5);
  assert.equal(effectiveZLayer(null, 3), 3);
  assert.equal(effectiveZLayer(7, 3), 7);
  assert.equal(effectiveZLayer(null, undefined), 0);
});

// --- timing ------------------------------------------------------------------

test("a value eases over key 10 with key 30's easing (Dash's chromatic at x = 1545 and 1575)", () => {
  // No key 10: set at once. Then back to 0 over 0.6 s, ease in-out, rate 2.
  // [ShaderLayer::tweenValueAuto :660404-660640; GJValueTween::step
  //  :417562-417600]
  const st = createShaderState();
  fire(st, 2910, { 188: 1, 180: 6 });
  assert.equal(st.v[TWEEN.CHROMATIC_X], 6);
  assert.equal(st.tweens.size, 0);
  fire(st, 2910, { 10: 0.6, 30: 1, 188: 1 });
  const x = (): number => st.v[TWEEN.CHROMATIC_X];
  stepShaderState(st, 0.15);
  near(x(), 5.25, "a quarter of the way");
  stepShaderState(st, 0.15);
  near(x(), 3, "half way");
  stepShaderState(st, 0.15);
  near(x(), 0.75, "three quarters");
  // Four steps of 0.15 land a hair under 0.6 in binary; overshoot it.
  stepShaderState(st, 0.2);
  assert.equal(x(), 0);
  assert.equal(st.tweens.size, 0, "a finished tween is dropped");
  assert.equal(shaderActive(st), false);
});

test("an instant set stops a tween that is running", () => {
  const st = createShaderState();
  fire(st, 2919, { 10: 1, 176: 1 });
  stepShaderState(st, 0.5);
  near(st.v[TWEEN.GRAYSCALE], 0.5, "half way");
  assert.equal(shaderActive(st), true);
  fire(st, 2919);
  assert.equal(st.v[TWEEN.GRAYSCALE], 0);
  assert.equal(st.tweens.has(TWEEN.GRAYSCALE), false);
  assert.equal(shaderActive(st), false);
});

test("an absent key is zero: Edit Colour with no multipliers fades to black", () => {
  // The Secret Hollow at x = 14865. [ShaderGameObject::customObjectSetup
  //  :308798-309007; preColorChangeShader :659117-659186]
  const st = createShaderState();
  fire(st, 2923, { 10: 2, 30: 1 });
  stepShaderState(st, 2);
  const u = colourUniforms(st, WHITE);
  nearAll(u.colorChangeC, [0.001, 0, 0], "the multiplier, red held above zero");
  nearAll(u.colorChangeB, [0, 0, 0], "nothing added");
  assert.equal(shaderActive(st), true);
  nearAll(applyColourTail([0.8, 0.6, 0.4], u), [0.0008, 0, 0], "black, near enough", 1e-6);
});

test("Dash's invert at x = 975 reaches full strength in 0.2 s, with red weighted twice and clamped", () => {
  // [triggerInvertColor :661362-661406; preInvertColorShader :658991-659018]
  const keys = { 10: 0.2, 176: 1, 179: 2, 180: 1, 189: 1, 188: 1, 194: 1, 85: 2 };
  let st = createShaderState();
  fire(st, 2921, keys);
  nearAll(invertOf(st), [0, 0, 0, 0], "right after");
  stepShaderState(st, 0.05);
  nearAll(invertOf(st), [0.5, 0.25, 0.25, 0.25], "0.05 s");
  stepShaderState(st, 0.05);
  nearAll(invertOf(st), [1, 0.5, 0.5, 0.5], "0.1 s");
  stepShaderState(st, 0.1);
  nearAll(invertOf(st), [1, 1, 1, 1], "0.2 s");
  stepShaderState(st, 1);
  nearAll(invertOf(st), [1, 1, 1, 1], "and it stays");

  const { 194: _clamp, ...unclamped } = keys;
  st = createShaderState();
  fire(st, 2921, unclamped);
  stepShaderState(st, 0.1);
  nearAll(invertOf(st), [1, 0.5, 0.5, 0.5], "0.1 s without the clamp");
  stepShaderState(st, 0.1);
  nearAll(invertOf(st), [2, 1, 1, 1], "0.2 s without the clamp");

  // The one at x = 1455 has no key 10 and no 176: off, at once.
  fire(st, 2921, { 175: 1, 181: 1, 182: 1, 191: 1 });
  assert.equal(st.v[TWEEN.INVERT], 0);
  assert.equal(shaderActive(st), false);
});

test("Disable All puts back the values the game resets and leaves the grayscale's tint alone", () => {
  // [GJShaderState::reset :659662-659738; resetAllShaders :659745-659751]
  const st = createShaderState();
  fire(st, 2919, { 176: 1, 190: 1, 51: 209, 188: 1 });
  fire(st, 2922, { 176: 50, 10: 3 });
  fire(st, 2923, { 176: 2 });
  stepShaderState(st, 0.5);
  fire(st, 2904, { 192: 1 });
  assert.equal(shaderActive(st), false);
  assert.equal(st.tweens.size, 0);
  assert.equal(st.v[TWEEN.HUE], 0);
  assert.deepEqual([st.v[TWEEN.CC_R], st.v[TWEEN.INVERT_R], st.v[TWEEN.LENS_SIZE]], [1, 1, 1]);
  assert.equal(st.s.grayscaleTint, 209);
  assert.equal(st.s.grayscaleUseLum, true);
});

test("Disable All leaves the centres, the shock values and their phases where they were", () => {
  // The reset never writes the lens circle's centre (14, 15), the bulge's
  // (22-24), the blur fade (48) or the shock wave's values (50-61), so a
  // timed trigger after it eases from there. [GJShaderState::reset
  //  :659662-659738; updateTweenAction :656133-656351]
  const st = createShaderState();
  fire(st, 2913, { 290: 1, 291: -0.5, 176: 1 });
  fire(st, 2916, { 176: 1, 290: 0.25, 180: 40 });
  fire(st, 2914, { 181: 0.3 });
  fire(st, 2905, { 175: 2, 176: 1 });
  stepShaderState(st, 0.5);
  const phase = st.s.shockWavePhase;
  assert.ok(phase > 0, "the wave has run");
  fire(st, 2904, { 192: 1 });
  assert.deepEqual([st.v[TWEEN.LENS_X], st.v[TWEEN.LENS_Y]], [1, -0.5], "the lens circle's centre");
  assert.deepEqual([st.v[TWEEN.BULGE_X], st.v[TWEEN.BULGE_RADIUS]], [0.25, 40], "the bulge's centre and radius");
  near(st.v[TWEEN.BLUR_FADE], 0.3, "the blur fade");
  assert.deepEqual([st.v[TWEEN.SW_SPEED], st.v[TWEEN.SW_STRENGTH]], [2, 1], "the shock wave's values");
  assert.equal(st.s.shockWavePhase, phase, "and how far it ran");
  assert.equal(st.s.shockWaveStart, 0, "but it is stopped");
  assert.deepEqual([st.v[TWEEN.LENS_STRENGTH], st.v[TWEEN.BULGE], st.v[TWEEN.BLUR_INTENSITY]], [0, 0, 0], "the strengths are reset");
  assert.equal(shaderActive(st), false);
  // A timed lens circle now moves its centre from the old spot.
  fire(st, 2913, { 10: 1, 290: 0, 176: 1 });
  stepShaderState(st, 0.5);
  near(st.v[TWEEN.LENS_X], 0.5, "half way back from 1");
});

test("a restart from the start carries the kept values into the next attempt", () => {
  // [PlayLayer::resetLevel → resetLevelVariables :462991-462996 → resetAllShaders]
  const previous = createShaderState();
  fire(previous, 2913, { 290: 1, 176: 1 });
  fire(previous, 2921, { 176: 1 });
  const carried = carriedShaderState(previous);
  assert.equal(carried.v[TWEEN.LENS_X], 1);
  assert.deepEqual([carried.v[TWEEN.LENS_STRENGTH], carried.v[TWEEN.INVERT]], [0, 0]);
  assert.equal(previous.v[TWEEN.LENS_STRENGTH], 1, "a copy: the last attempt's layer is left as it was");

  const sim = makeSim(emptyLevel([]), undefined, { visuals: true, shader: previous });
  assert.equal(sim.triggers.visual.shader.v[TWEEN.LENS_X], 1, "the sim starts from it");
  assert.equal(shaderActive(sim.triggers.visual.shader), false);
  const fresh = makeSim(emptyLevel([]), undefined, { visuals: true });
  assert.equal(fresh.triggers.visual.shader.v[TWEEN.LENS_X], 0, "a first attempt starts from nothing");
});

test("the chromatic glitch's phase moves only while it draws, and wraps at 1000", () => {
  // [preChromaticGlitchShader :657941-657980; triggerChromaticGlitch :660894-660955]
  const st = createShaderState();
  fire(st, 2911, { 175: 2, 176: 1 });
  assert.equal(st.s.cgPhase, 10000, "a glitch switched on starts its phase at the clock");
  stepShaderState(st, 0.5);
  near(st.s.cgPhase, 1, "10000 + 0.5 × 2, wrapped");
  near(st.s.cgLast, 10000.5, "the clock it read", 1e-3);
  fire(st, 2911, { 175: 2 });
  const phase = st.s.cgPhase;
  assert.equal(st.s.cgOn, true, "still on, with nothing to draw");
  assert.equal(shaderActive(st), false);
  stepShaderState(st, 0.5);
  stepShaderState(st, 0.5);
  assert.equal(st.s.cgPhase, phase, "not drawn, so not moved");
  fire(st, 2911, { 175: 2, 191: 1 });
  near(st.s.cgPhase, phase + 2, "the trigger itself catches up", 1e-3);
});

// --- the colour tail -----------------------------------------------------------

function uniforms(over: Partial<ColourUniforms>): ColourUniforms {
  return {
    grayscale: 0,
    grayscaleUseLum: false,
    grayscaleTint: [1, 1, 1],
    sepia: 0,
    invert: [0, 0, 0, 0],
    hueCos: 1,
    hueSin: 0,
    colorChangeC: [0, 0, 0],
    colorChangeB: [0, 0, 0],
    ...over,
  };
}

test("the shader's colour tail, number for number", () => {
  // The install's fragment shader, GeometryDash.exe at 0x604740.
  const c: [number, number, number] = [0.2, 0.4, 0.6];
  const tail = (u: Partial<ColourUniforms>, from = c): [number, number, number] => applyColourTail(from, uniforms(u));
  nearAll(tail({ invert: [1, 1, 1, 1] }), [0.8, 0.6, 0.4], "full invert", 1e-4);
  nearAll(tail({ invert: [1, 0.5, 0.5, 0.5] }), [0.8, 0.5, 0.5], "Dash's, half way", 1e-4);
  nearAll(tail({ grayscale: 1 }), [0.3996, 0.3996, 0.3996], "grayscale by the plain average", 1e-4);
  nearAll(tail({ grayscale: 1, grayscaleUseLum: true }), [0.363, 0.363, 0.363], "grayscale by luminance", 1e-4);
  nearAll(tail({ grayscale: 0.5 }), [0.2998, 0.3998, 0.4998], "half a grayscale", 1e-4);
  nearAll(tail({ sepia: 1 }), [0.4996, 0.445, 0.3466], "sepia", 1e-4);
  // Mixed before any clamp: clamp-then-mix gave red 0.9.
  nearAll(tail({ sepia: 0.5 }, [0.8, 0.8, 0.8]), [0.9404, 0.8812, 0.7748], "half a sepia on light grey", 1e-4);
  const hue = (deg: number): Partial<ColourUniforms> => ({ hueCos: Math.cos(deg * 0.017453), hueSin: Math.sin(deg * 0.017453) });
  nearAll(tail(hue(120), [1, 0, 0]), [0, 1, 0], "a third of the way round", 1e-4);
  nearAll(tail(hue(-30), [1, 0, 0]), [0.9107, 0, 0.3333], "back 30°, green clamped at the end", 1e-4);
  nearAll(tail({ grayscale: 1, invert: [1, 1, 1, 1] }), [0.6004, 0.6004, 0.6004], "grayscale first, then invert", 1e-4);
});

test("Edit Colour multiplies red, green and blue by 176, 191 and 175, and adds 179, 180 and 189", () => {
  const st = createShaderState();
  fire(st, 2923, { 176: 1.5, 191: 1.2, 175: 0.9 });
  nearAll(applyColourTail([0.4, 0.4, 0.4], colourUniforms(st, WHITE)), [0.6, 0.48, 0.36], "channel order", 1e-5);
  // Dash at x = 2475.
  fire(st, 2923, { 175: 1.1, 176: 1.1, 191: 1.1, 179: 0.2, 180: 0.05 });
  nearAll(applyColourTail([0.5, 0.5, 0.5], colourUniforms(st, WHITE)), [0.75, 0.6, 0.55], "with the add", 1e-5);
});

test("an identity colour change is off", () => {
  const st = createShaderState();
  fire(st, 2923, { 176: 1, 191: 1, 175: 1 });
  assert.equal(shaderActive(st), false);
  assert.deepEqual(colourUniforms(st, WHITE).colorChangeC, [0, 0, 0]);
});

test("the hue shift is key 176 in degrees", () => {
  const st = createShaderState();
  fire(st, 2922, { 176: 120 });
  nearAll(applyColourTail([1, 0, 0], colourUniforms(st, WHITE)), [0, 1, 0], "120°", 1e-4);
});

test("a grayscale tints by key 51's channel only with key 190", () => {
  const st = createShaderState();
  const channel = (id: number): { r: number; g: number; b: number } => (id === 209 ? { r: 255, g: 0, b: 0 } : WHITE());
  fire(st, 2919, { 176: 1, 51: 209 });
  assert.deepEqual(colourUniforms(st, channel).grayscaleTint, [1, 1, 1]);
  fire(st, 2919, { 176: 1, 51: 209, 190: 1 });
  assert.deepEqual(colourUniforms(st, channel).grayscaleTint, [1, 0, 0]);
});

// --- the band's other uniforms -------------------------------------------------

function scene(over: Partial<BandScene> = {}): BandScene {
  return {
    width: 1920,
    height: 1080,
    zoom: 1,
    angle: 0,
    colourOf: (id) => (id === 5 ? { r: 255, g: 0, b: 0, blending: true } : { r: 0, g: 0, b: 255, blending: false }),
    targetOnScreen: () => false,
    ...over,
  };
}

test("the chromatic offset is its value in points over G, and scales with the zoom when relative", () => {
  // At 16:9 the screen is 568.9 by 320 points; G = sqrt(960² + 640²) / 960.
  // [2.2074 exe VA 0x1404883b9-0x14048842d]
  const st = createShaderState();
  fire(st, 2910, { 188: 1, 180: 6, 190: 1, 189: 5 });
  const g = Math.hypot(960, 640) / 960;
  let u = bandUniforms(st, scene());
  near(u.chromaticX, 6 / (g * (320 * 16) / 9), "x, in screen widths");
  near(u.chromaticY, 5 / (g * 320), "y, in screen heights");
  near(u.screenAspect, 0.5625, "height over width");
  fire(st, 2910, { 188: 1, 180: 6, 514: 1 });
  u = bandUniforms(st, scene({ zoom: 2 }));
  near(u.chromaticX, (2 * 6) / (g * (320 * 16) / 9), "relative, at zoom 2");
});

test("the lens circle's radius, fade, tint and centre", () => {
  // end = size × G / (width / 480) screen widths, start = end − fade.
  // [2.2074 exe VA 0x1404868f1-0x1404869a0, the origin 0x1404834f9-0x1404835c0]
  const st = createShaderState();
  fire(st, 2913, { 176: 0.9, 179: 0.2, 181: 0.1, 71: 5 });
  const g = Math.hypot(960, 640) / 960;
  const unit = g / ((320 * 16) / 9 / 480);
  let u = bandUniforms(st, scene());
  near(u.lensStrength, 0.9, "strength");
  near(u.lensEnd, 0.2 * unit, "end");
  near(u.lensStart, 0.2 * unit - 0.1, "start");
  nearAll(u.lensOrigin, [0.5, 0.28125], "the middle of the screen, y in widths");
  assert.deepEqual(u.lensTint, [1, 0, 0]);
  assert.equal(u.lensAdditive, true, "channel 5 blends");
  fire(st, 2913, { 176: 3, 179: 0.2, 138: 1, 290: 1 });
  u = bandUniforms(st, scene({ targetOnScreen: (t, out) => (t === -1 ? ((out[0] = 0.25), (out[1] = 0.5), true) : false) }));
  near(u.lensStrength, 1, "strength is clamped into 0..1");
  nearAll(u.lensOrigin, [0.25, 0.28125], "on player 1");
  assert.deepEqual(u.lensTint, [0, 0, 0], "no key 71, no tint");
  u = bandUniforms(st, scene());
  nearAll(u.lensOrigin, [1, 0.28125], "no player to be found: key 290 puts it at the right edge");
});

test("a shock wave stores invert/follow and draws a non-zero time uniform", () => {
  // [triggerShockWave :660694-660702; preShockWaveShader :657279-657423]
  const st = createShaderState();
  fire(st, 2905, { 175: 2, 176: 1, 180: 0.5, 184: 1, 188: 1, 138: 1, 290: -0.5, 291: 0.25 });
  assert.equal(st.s.shockWaveInvert, true);
  assert.equal(st.s.shockWaveFollow, true);
  assert.equal(st.s.shockWaveTarget, -1);
  stepShaderState(st, 0.25);
  const u = bandUniforms(
    st,
    scene({ targetOnScreen: (t, out) => (t === -1 ? ((out[0] = 0.3), (out[1] = 0.4), true) : false) }),
  );
  assert.ok(u.shockWaveTime > 0, "the wave is on");
  assert.equal(u.shockWaveInvert, true);
  nearAll(u.shockWaveCenter, [0.3, 0.4 * 0.5625], "follows player 1");
  assert.ok(u.shockWaveStrength > 0);
});

test("follow centres turn about the screen middle with Camera Rotate", () => {
  // [updateEffectOffsets :656738-656756, rotatePoint :656586-656608]
  const st = createShaderState();
  const aspect = 0.5625;
  const at = (t: number, out: [number, number]) =>
    t === -1 ? ((out[0] = 0.75), (out[1] = 0.5), true) : false;
  fire(st, 2905, { 176: 1, 188: 1, 138: 1 });
  stepShaderState(st, 0.1);
  let u = bandUniforms(st, scene({ angle: 90, targetOnScreen: at }));
  // (0.75, 0.5·aspect) about (0.5, 0.5·aspect), 90° clockwise → (0.5, 0.5·aspect − 0.25)
  nearAll(u.shockWaveCenter, [0.5, 0.5 * aspect - 0.25], "shock wave, 90°");

  fire(st, 2907, { 176: 1, 188: 1, 138: 1 });
  stepShaderState(st, 0.1);
  u = bandUniforms(st, scene({ angle: 90, targetOnScreen: at }));
  near(u.shockLineCenter, 0.5, "shock line x, 90°");

  fire(st, 2913, { 176: 1, 179: 0.2, 138: 1 });
  u = bandUniforms(st, scene({ angle: 90, targetOnScreen: at }));
  nearAll(u.lensOrigin, [0.5, 0.5 * aspect - 0.25], "lens circle, 90°");

  fire(st, 2914, { 179: 1, 188: 1, 138: 1 });
  u = bandUniforms(st, scene({ angle: -90, targetOnScreen: at }));
  nearAll(u.radialBlurCenter, [0.5, 0.5 * aspect + 0.25], "radial blur, −90°");

  fire(st, 2916, { 176: 1, 180: 40, 188: 1, 138: 1 });
  u = bandUniforms(st, scene({ angle: 180, targetOnScreen: at }));
  nearAll(u.bulgeOrigin, [0.25, 0.5 * aspect], "bulge, 180°");

  fire(st, 2917, { 188: 1, 180: 1, 138: 1, 190: 1 });
  u = bandUniforms(st, scene({ angle: 90, targetOnScreen: at }));
  nearAll(u.pinchCenter, [0.5, 0.5 * aspect - 0.25], "pinch, 90°");
});

test("a fixed centre turns about the screen middle with Camera Rotate", () => {
  const st = createShaderState();
  const aspect = 0.5625;
  fire(st, 2905, { 176: 1, 290: 1, 291: 0 });
  stepShaderState(st, 0.1);
  const u = bandUniforms(st, scene({ angle: 90 }));
  // Right edge (1, 0.5·aspect) → 90° clockwise about the middle → (0.5, 0.5·aspect − 0.5)
  nearAll(u.shockWaveCenter, [0.5, 0.5 * aspect - 0.5], "fixed offset, 90°");
});

test("bulge, split screen and pixelate reach the band uniforms", () => {
  const st = createShaderState();
  fire(st, 2916, { 176: 1, 180: 40, 290: 0.5, 188: 1, 138: 1 });
  assert.equal(st.s.bulgeTarget, -1);
  let u = bandUniforms(st, scene());
  assert.ok(u.bulgeValue > 0, "bulge on");
  nearAll(u.bulgeOrigin, [0.75, (0.5 + 0.5 * 0) * 0.5625], "no player: key 290", 1e-4);

  fire(st, 2924, { 188: 1, 180: 1, 190: 1, 189: 2 });
  u = bandUniforms(st, scene());
  near(u.colmod, 2, "cols + 1");
  near(u.rowmod, 3, "rows + 1");

  fire(st, 2912, { 188: 1, 180: 4, 190: 1, 189: 2 });
  u = bandUniforms(st, scene());
  nearAll(u.textureScale, [4, 2], "pixelate scale");
  nearAll(u.textureScaleInv, [0.25, 0.5], "and its inverse");
});

test("a fresh shock wave's switches are not rewritten by a companion", () => {
  const st = createShaderState();
  fire(st, 2905, { 176: 1, 184: 1, 188: 1 });
  assert.equal(st.s.shockWaveInvert, true);
  fire(st, 2905, { 176: 0.5, 513: 1 });
  assert.equal(st.s.shockWaveInvert, true, "companion keeps invert");
  assert.equal(st.s.shockWaveFollow, true, "and follow");
});

// --- the runtime ----------------------------------------------------------------

test("a checkpoint keeps the effects as they were, not as they became", () => {
  // [PlayLayer::createCheckpoint :105118, loadFromCheckpoint :105529-105531]
  const level = emptyLevel([{ id: 2921, x: 60, y: 300, props: { 10: "1", 176: "1" } }]);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: STANDING_Y } });
  while (sim.state.x < 61) sim.step(NO_INPUT);
  const shader = (): ShaderState => sim.triggers.visual.shader;
  assert.ok(shader().tweens.has(TWEEN.INVERT), "the invert has fired");
  const snap = sim.snapshot();
  sim.triggers.updateVisuals(0.5);
  near(shader().v[TWEEN.INVERT], 0.5, "half way");
  sim.restore(snap);
  assert.equal(shader().v[TWEEN.INVERT], 0);
  assert.equal(shader().tweens.get(TWEEN.INVERT)?.elapsed, 0);
  sim.triggers.updateVisuals(0.25);
  sim.restore(snap);
  assert.equal(shader().tweens.get(TWEEN.INVERT)?.elapsed, 0, "and again after a second restore");
});

test("the shader triggers are done where the game's arithmetic is reproduced", () => {
  for (const id of [2904, 2905, 2907, 2909, 2910, 2911, 2912, 2913, 2914, 2915, 2916, 2917, 2919, 2920, 2921, 2922, 2923, 2924]) {
    assert.equal(statusOf(id).status, "done", `${id}`);
  }
  assert.equal(SHADER_TRIGGER_IDS.has(2906) || SHADER_TRIGGER_IDS.has(2908) || SHADER_TRIGGER_IDS.has(2918), false);
});

// --- the draw list's layers ------------------------------------------------------

const deco: ObjectRecord = { k: "decoration", hb: null, src: "table", p: { hb: "none", art: "manual", z: "none" }, f: "a.png", bc: 1004, zl: 3 };

function oneFrameAtlas(): AtlasSet {
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [{ name: "t", image: "t.png", w: 128, h: 128, frames: [{ n: "a.png", x: 0, y: 0, w: 120, h: 120 }] }],
    frames: { "a.png": [0, 0] },
  };
  return new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
}

test("the draw list hands its sprites over one batch layer at a time", () => {
  // Objects placed out of order: T1, B5, then three in B1. Key 24 = 0 is the
  // type's default layer (B1 here), not B2, and key 25 = 0 its default z
  // order (5 here), not 0, so the one at x = 90 sorts after the one at
  // x = 120 with z order 4. [getObjectZLayer :169016-169023;
  //  getObjectZOrder :169248-169255]
  const objects: LevelObject[] = buildLevel([
    { id: 5, x: 0, y: 0, props: { 24: "5" } },
    { id: 5, x: 30, y: 0, props: { 24: "-5" } },
    { id: 5, x: 60, y: 0, props: { 24: "0" } },
    { id: 5, x: 90, y: 0, props: { 24: "0", 25: "0" } },
    { id: 5, x: 120, y: 0, props: { 24: "3", 25: "4" } },
  ]).objects.map((o) => ({
    ...o,
    zLayer: o.props[24] !== undefined ? Number(o.props[24]) : null,
    zOrder: o.props[25] !== undefined ? Number(o.props[25]) : null,
  }));
  const level = { header: makeHeader(), objects, lengthUnits: 1000 };
  const record: ObjectRecord = { ...deco, zo: 5 };
  const list = DrawList.build(level, () => record, oneFrameAtlas(), ColorTable.resolve(makeHeader()));
  const data = list.visible({ x0: -500, y0: -500, x1: 500, y1: 500 }, null, 0);
  assert.equal(list.visibleCount, 5);
  assert.deepEqual([...list.runZ.slice(0, list.runs)], [-1220, -20, 360], "B5's, B1's and T1's GJ_GameSheet batches");
  assert.deepEqual([...list.runStart.slice(0, list.runs)], [0, 1, 4]);
  assert.deepEqual([...list.runCount.slice(0, list.runs)], [1, 3, 1]);
  assert.deepEqual([...list.layerRuns], [1, 0, 0, 0, 1, 1, 0, 0, 0]);
  assert.deepEqual([list.layerRunFirst[0], list.layerRunFirst[4], list.layerRunFirst[5]], [0, 1, 2]);
  const xs = [0, 1, 2, 3, 4].map((i) => data[i * 12 + 4]);
  assert.deepEqual(xs, [30, 120, 60, 90, 0], "B5, then B1 by z order and placement, then T1");
  assert.deepEqual([effectiveZOrder(0, 5), effectiveZOrder(null, 5), effectiveZOrder(-2, 5), effectiveZOrder(null, undefined)], [5, 5, -2, 0]);
});

// --- the game's shader --------------------------------------------------------------

test("the asset build finds the shader by its uniforms", () => {
  const source = `precision mediump float;\nuniform float _shockWaveTime;\nvoid main() {}`;
  const bytes = Buffer.concat([Buffer.from("junk\0"), Buffer.from(source), Buffer.from("\0more")]);
  assert.equal(stringAround(bytes, "uniform float _shockWaveTime;"), source);
  assert.equal(stringAround(bytes, "_nothing"), null);
  const all = SHADER_UNIFORMS.map((n) => `uniform ${n === "_lensCircleOrigin" ? "PRECISION vec2" : "float"} ${n};`).join("\n");
  assert.deepEqual(missingUniforms(all), []);
  assert.deepEqual(missingUniforms(all.replace("_sepiaValue", "_sepia")), ["_sepiaValue"]);
});

test("the game's shader converts to GLSL ES 3.00", { skip: NO_SHADER }, () => {
  const file = JSON.parse(readFileSync(SHADER_ASSET, "utf8")) as ShaderLayerFile;
  assert.deepEqual(missingUniforms(file.fragment), []);
  const out = toGlsl300(file.fragment);
  assert.ok(out.startsWith("#version 300 es\n"));
  for (const gone of [/\bvarying\b/, /\bgl_FragColor\b/, /\btexture2D\b/]) assert.equal(gone.test(out), false, `${gone} is left`);
  const precision = out.indexOf("precision mediump float;");
  const output = out.indexOf("out vec4 fragColor;");
  assert.ok(precision >= 0 && output > precision, "the output is declared after the precision statement");
  // The fixed order the colour tail relies on.
  const order = ["_grayscaleValue > 0.0", "_sepiaValue > 0.0", "_invertColorValue.a > 0.0", "_hueShiftCosA != 0.0", "_colorChangeC.r > 0.0", "_lensCircleStrength > 0.0"];
  const at = order.map((s) => out.indexOf(s));
  assert.ok(at.every((a, i) => a > 0 && (i === 0 || a > at[i - 1])), `order: ${at.join(", ")}`);
});

// --- the official levels ---------------------------------------------------------

test("Dash's spider section: the invert reaches the player alone, at once, and goes off at 1455", { skip: LEVELS }, async () => {
  const dash = await loadOfficialLevel(22);
  const wanted: [number, number][] = [
    [2904, 945],
    [2921, 975],
    [2921, 1455],
    [2904, 1477],
  ];
  const placed = wanted.map(([id, x]) => {
    const o = dash.objects.find((p) => p.id === id && p.x === x);
    assert.ok(o, `Dash has a ${id} at x = ${x}`);
    const props: Record<number, string> = { ...o.props, 3: "300" };
    return { id, x, y: 300, props };
  });
  const level = emptyLevel(placed);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: STANDING_Y, mode: "cube" } });
  const shader = (): ShaderState => sim.triggers.visual.shader;
  while (sim.state.x <= 976) sim.step(NO_INPUT);
  assert.deepEqual([shader().layerMin, shader().layerMax, shader().noPlayerParticles], [8, 8, true]);
  assert.ok(shader().tweens.has(TWEEN.INVERT));
  sim.triggers.updateVisuals(0.05);
  nearAll(invertOf(shader()), [0.5, 0.25, 0.25, 0.25], "0.05 s in");
  sim.triggers.updateVisuals(0.15);
  nearAll(invertOf(shader()), [1, 1, 1, 1], "0.2 s in");
  assert.equal(objectSide(59, shader()), 0, "the player is in the band");
  assert.equal(objectSide(LAYER_Z[5], shader()), 1, "T1 is above it");
  assert.equal(objectSide(LAYER_Z[4], shader()), -1, "B1 is below it");
  while (sim.state.x <= 1456) sim.step(NO_INPUT);
  assert.equal(shader().v[TWEEN.INVERT], 0);
  assert.equal(shaderActive(shader()), false);
  while (sim.state.x <= 1478) sim.step(NO_INPUT);
  assert.deepEqual([shader().layerMin, shader().layerMax, shader().noPlayerParticles], [1, 15, false]);
});

test("every official shader trigger decodes to finite values and a range in 1..15", { skip: LEVELS }, async () => {
  let placements = 0;
  for (const id of [22, 5001, 5002, 5003, 5004]) {
    const level = await loadOfficialLevel(id);
    const st = createShaderState();
    const shaders = level.objects.filter((o) => SHADER_TRIGGER_IDS.has(o.id)).sort((a, b) => a.x - b.x);
    for (const o of shaders) {
      applyShaderTrigger(st, parseTrigger(o));
      stepShaderState(st, 0.25);
      assert.ok(st.v.every(Number.isFinite), `level ${id}, ${o.id} at x = ${o.x}`);
      assert.ok(st.layerMin >= 1 && st.layerMin <= 15 && st.layerMax >= 1 && st.layerMax <= 15, `level ${id} range`);
      placements++;
    }
  }
  assert.equal(placements, 227);
});
