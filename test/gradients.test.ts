// The Gradient trigger: which layer it keeps, where the quad goes and how
// its colour runs, and the strips it is drawn as.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level, LevelObject } from "../src/level/types";
import { NO_INPUT } from "../src/physics/types";
import type { ColorSource, ResolvedChannel } from "../src/render/colors";
import { GRADIENT_SLOT, GradientPainter, gradientSlot, placeGradient, type GradientWorld } from "../src/render/gradients";
import type { GradientState, TriggerRuntime } from "../src/triggers/runtime";
import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS, blendNeedsGl } from "../src/engine/gl/spriteBatch";
import { makeSim } from "./helpers";
import { emptyLevel } from "./levelKit";

function obj(index: number, over: Partial<LevelObject> = {}): LevelObject {
  return {
    index,
    id: 1,
    x: 0,
    y: 0,
    rotation: 0,
    flipX: false,
    flipY: false,
    scaleX: 1,
    scaleY: 1,
    groups: [],
    zLayer: null,
    zOrder: null,
    baseColor: null,
    detailColor: null,
    legacyColor: null,
    baseHsv: null,
    detailHsv: null,
    editorLayer: null,
    props: {},
    settings: null,
    ...over,
  };
}

const channel = (r: number, g: number, b: number, a = 1, blending = false): ResolvedChannel => ({ r, g, b, a, blending });

/**
 * Dash's gradient at x 825: turned −90, from the guide in group 103 (y 175)
 * down to the one in group 102 (y −5), additive, from channel 78 to 79.
 */
function dashWorld(start = channel(216, 0, 255), end = channel(78, 0, 255, 0)): { world: GradientWorld; state: GradientState } {
  const objects = [
    obj(0, { id: 2903, rotation: -90 }),
    obj(1, { id: 1964, x: 1025, y: 175, groups: [103] }),
    obj(2, { id: 1964, x: 1025, y: -5, groups: [102] }),
  ];
  const level = { header: {}, objects, lengthUnits: 2000 } as unknown as Level;
  const mains = new Map([
    [103, 1],
    [102, 2],
  ]);
  const triggers = {
    groupAlphaOf: () => 1,
    mainObjectOf: (g: number) => mains.get(g) ?? -1,
    objectPosition: (i: number) => [objects[i].x, objects[i].y],
    objectTransform: (_i: number, m: Float64Array) => {
      m.set([1, 0, 0, 1, 0, 0, 0, 1, 1]);
      return false;
    },
  } as unknown as TriggerRuntime;
  const colours = new Map([
    [78, start],
    [79, end],
  ]);
  const colors: ColorSource = { get: (id) => colours.get(id ?? 0) ?? channel(255, 255, 255) };
  const world: GradientWorld = { level, triggers, colors, view: { x0: 1000, y0: 16, x1: 1626, y1: 314 } };
  const state: GradientState = { id: 0, object: 0, layer: 5, blend: 1, vertexMode: false, groups: [103, 102, 0, 0], start: 78, end: 79 };
  return { world, state };
}

test("a gradient's sides come from its groups, the view's edges 20 out where it has none", () => {
  // [gdp updateGradientLayers :423700-423760: 204 the bottom's y, 205 the
  //  left's x, 203 the top's y, 206 the right's x]
  const { world, state } = dashWorld();
  const q = placeGradient(state, world);
  assert.ok(q);
  assert.deepEqual(q.corners, [980, -5, 1646, -5, 980, 175, 1646, 175]);
});

test("turned −90 the colour runs from the start at the bottom to the end at the top", () => {
  // The vector is (cos −r, sin −r), (0, 1) here, and CCLayerGradient puts the
  // start where it points from. [:423700-423704; CCLayerGradient::updateColor
  //  :820617-820690]
  const { world, state } = dashWorld();
  const q = placeGradient(state, world)!;
  const near = (a: number[], b: number[]) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${a} vs ${b}`));
  near(q.weights, [1, 1, 0, 0]);
  assert.deepEqual([q.start, q.startAlpha, q.end, q.endAlpha, q.blend], [{ r: 216, g: 0, b: 255, a: 1, blending: false }, 1, { r: 78, g: 0, b: 255, a: 0, blending: false }, 0, BLEND.ADD]);
});

test("a gradient shows nothing when both ends are clear, an additive one when both are black", () => {
  // [:423680-423692; the blend modes, triggerGradientCommand :436358-436376]
  const clear = dashWorld(channel(216, 0, 255, 0), channel(78, 0, 255, 0));
  assert.equal(placeGradient(clear.state, clear.world), null);
  const black = dashWorld(channel(0, 0, 0), channel(0, 0, 0, 0));
  assert.equal(placeGradient(black.state, black.world), null);
  assert.ok(placeGradient({ ...black.state, blend: 0 }, black.world), "a normal black one covers");
  assert.ok(placeGradient({ ...black.state, blend: 2 }, black.world), "a multiply black one still multiplies");
  assert.ok(placeGradient({ ...black.state, blend: 3 }, black.world), "an invert black one still inverts");
});

test("blends 2 and 3 multiply and invert, with their own GL blend on the strips", () => {
  // [gdp triggerGradientCommand :436371-436389 (774/771 and 775/769)]
  const { world, state } = dashWorld();
  const multiply = placeGradient({ ...state, blend: 2 }, world)!;
  const invert = placeGradient({ ...state, blend: 3 }, world)!;
  assert.equal(multiply.blend, BLEND.MULTIPLY);
  assert.equal(invert.blend, BLEND.INVERT);
  assert.equal(blendNeedsGl(BLEND.MULTIPLY), true);
  assert.equal(blendNeedsGl(BLEND.INVERT), true);
  assert.equal(blendNeedsGl(BLEND.ADD), false);
  const painter = new GradientPainter();
  const white = { u0: 0, v0: 0, du: 1, dv: 1, unit: 13, w: 1, h: 1 };
  painter.update([{ ...state, blend: 2 }], world, white);
  const slot = GRADIENT_SLOT.BEHIND + 2;
  assert.equal(painter.layerCount[slot], 48);
  const bytes = new Uint8Array(painter.buffer.buffer);
  assert.equal(bytes[painter.layerStart[slot] * INSTANCE_BYTES + 46], BLEND.MULTIPLY);
  painter.update([{ ...state, blend: 3 }], world, white);
  assert.equal(new Uint8Array(painter.buffer.buffer)[painter.layerStart[slot] * INSTANCE_BYTES + 46], BLEND.INVERT);
});

test("a gradient off the view shows nothing", () => {
  const { world, state } = dashWorld();
  assert.equal(placeGradient(state, { ...world, view: { x0: 1000, y0: 400, x1: 1626, y1: 700 } }), null);
});

test("the layers draw after their parts: the world's over their batch layer, the rest over their own art", () => {
  assert.equal(gradientSlot(1), GRADIENT_SLOT.BACKGROUND);
  assert.equal(gradientSlot(2), GRADIENT_SLOT.MIDDLEGROUND);
  assert.equal(gradientSlot(5), GRADIENT_SLOT.BEHIND + 2, "B3");
  assert.equal(gradientSlot(8), GRADIENT_SLOT.PLAYER);
  assert.equal(gradientSlot(9), GRADIENT_SLOT.FRONT);
  assert.equal(gradientSlot(13), GRADIENT_SLOT.GROUND);
  assert.equal(gradientSlot(15), GRADIENT_SLOT.GROUND);
});

test("the quad is drawn as strips across the way the colour runs, each its own colour", () => {
  const { world, state } = dashWorld();
  const painter = new GradientPainter();
  const white = { u0: 0, v0: 0, du: 1, dv: 1, unit: 13, w: 1, h: 1 };
  painter.update([state], world, white);
  const slot = GRADIENT_SLOT.BEHIND + 2;
  assert.equal(painter.layerCount[slot], 48, "one row of 48 strips up the quad");
  const data = painter.buffer;
  const bytes = new Uint8Array(data.buffer);
  const first = 0;
  const last = (painter.layerStart[slot] + 47) * INSTANCE_FLOATS;
  // The bottom strip: nearly the start, nearly opaque, additive.
  assert.ok(Math.abs(data[first + 5] - (-5 + 180 / 96)) < 1e-9, "the first strip's middle");
  assert.ok(bytes[43] > 245 && bytes[40] > 210 && bytes[46] === BLEND.ADD);
  // The top strip: nearly the end and nearly clear.
  assert.ok(bytes[(painter.layerStart[slot] + 47) * INSTANCE_BYTES + 43] < 8);
  assert.ok(Math.abs(data[last + 3] - 180 / 96) < 1e-9, "each strip is 180 / 48 tall");
});

test("a Gradient trigger keeps its layer by id, and keys 208 and 508 take layers away", () => {
  // [gdp triggerGradientCommand :436340-436354]
  const level = emptyLevel([
    { id: 2903, x: 60, y: 300, props: { 21: "3", 22: "4", 202: "5", 209: "2" } },
    { id: 2903, x: 90, y: 300, props: { 21: "5", 22: "6", 202: "0", 209: "1" } },
    { id: 2903, x: 120, y: 300, props: { 21: "7", 22: "8", 202: "9", 209: "2" } },
    { id: 2903, x: 300, y: 300, props: { 208: "1", 209: "1" } },
    { id: 2903, x: 450, y: 300, props: { 508: "1" } },
  ]);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const layers = () => sim.triggers.visual.gradients.map((g) => [g.id, g.layer, g.start]);
  while (sim.state.x < 200) sim.step(NO_INPUT);
  assert.deepEqual(layers(), [
    [2, 9, 7],
    [1, 1, 5],
  ], "the second trigger with id 2 takes its layer over, and a layer below 1 is 1");
  while (sim.state.x < 350) sim.step(NO_INPUT);
  assert.deepEqual(layers(), [[2, 9, 7]], "208 takes id 1 away");
  while (sim.state.x < 500) sim.step(NO_INPUT);
  assert.deepEqual(layers(), [], "508 takes them all");
});
