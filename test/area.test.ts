// The area triggers' falloff, easing and variance, against the decompile's
// arithmetic as data/ref/gd-areas.md writes it out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { areaEase, areaRandom, areaRate, areaValue, variance } from "../src/triggers/area";
import { emptyLevel, simOn, stepN } from "./levelKit";
import { NO_INPUT } from "../src/physics/types";
import { areaTinted } from "../src/render/drawList";

const near = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("a radial area is 0 at its centre and 1 at its length", () => {
  near(areaValue(0, 0, 0, 0, 0, 0, 0, 100, 1, 1, 0, false).v, 0);
  near(areaValue(0, 50, 0, 0, 0, 0, 0, 100, 1, 1, 0, false).v, 0.5);
  near(areaValue(0, 0, 150, 0, 0, 0, 0, 100, 1, 1, 0, false).v, 1);
});

test("the length is cut to a whole number before it divides", () => {
  near(areaValue(0, 50, 0, 0, 0, 0, 0, 100.9, 1, 1, 0, false).v, 0.5);
});

test("an axis area gives the whole effect behind its centre unless it is two-sided", () => {
  near(areaValue(1, -80, 0, 0, 0, 0, 0, 100, 1, 1, 0, false).v, 0);
  near(areaValue(1, -80, 0, 0, 0, 0, 0, 100, -1, 1, 0, false).v, 0.8);
  near(areaValue(2, 0, 40, 0, 0, 0, 0, 100, 1, 1, 0, false).v, 0.4);
});

test("a dead zone stretches the rest of the range, and invert turns it over", () => {
  near(areaValue(1, 20, 0, 0, 0, 0, 0, 100, 1, 1, 0.2, false).v, 0);
  near(areaValue(1, 60, 0, 0, 0, 0, 0, 100, 1, 1, 0.2, false).v, 0.5);
  near(areaValue(1, 60, 0, 0, 0, 0, 0, 100, 1, 1, 0.2, true).v, 0.5);
  near(areaValue(1, 20, 0, 0, 0, 0, 0, 100, 1, 1, 0.2, true).v, 1);
});

test("the side is which side of the centre the object is on", () => {
  assert.equal(areaValue(1, 10, 0, 0, 0, 0, 0, 100, 1, 1, 0, false).side, true);
  assert.equal(areaValue(1, -10, 0, 0, 0, 0, 0, 100, -1, 1, 0, false).side, false);
});

test("linear easing is the value itself, and a sampled curve meets its ends", () => {
  near(areaEase(0.37, 0, 2), 0.37);
  near(areaEase(0, 1, 2), 0);
  near(areaEase(1, 1, 2), 1);
  near(areaEase(0.5, 1, 2), 0.5, 1e-3);
});

test("an easing rate is cut to hundredths", () => {
  assert.equal(areaRate(0.799), 0.79);
  assert.equal(areaRate(2), 2);
});

test("every object's variance is fixed, in [-1, 1], and differs by field", () => {
  const a = areaRandom(50);
  const b = areaRandom(50);
  for (let i = 0; i < 50; i++) {
    const v = variance(a, i, 223);
    assert.ok(v >= -1 && v <= 1);
    assert.equal(v, variance(b, i, 223));
  }
  assert.notEqual(variance(a, 3, 223), variance(a, 3, 221));
  assert.equal(variance(a, 3, 999), 0);
});

// --- Area Fade and Tint ---------------------------------------------------------

/** An area trigger at the start on group 7 (two blocks 50 apart, high up), centred on group 8, the first of them. */
function visualLevel(id: number, props: Record<number, string>) {
  const level = emptyLevel([
    { id, x: 0, y: 300, props: { 51: "7", 71: "8", 222: "100", ...props } },
    { id: 1, x: 300, y: 900 },
    { id: 1, x: 350, y: 900 },
  ]);
  const n = level.objects.length;
  level.objects[n - 2].groups = [7, 8];
  level.objects[n - 1].groups = [7];
  return { level, a: n - 2, b: n - 1 };
}

test("an Area Fade gives key 286's opacity at its centre and key 275's at its edge", () => {
  // [gdp processAreaFadeGroupAction :426992-427057]
  const { level, a, b } = visualLevel(3009, { 286: "0.2", 275: "1" });
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  near(sim.triggers.areaVisualOf(a)?.opacity ?? -1, 0.2);
  near(sim.triggers.areaVisualOf(b)?.opacity ?? -1, 0.6);
});

test("an Area Tint mixes its channel in by its share at the centre, less further out", () => {
  // [gdp processAreaTintGroupAction :427325-427383]
  const { level, a, b } = visualLevel(3010, { 260: "1", 265: "1" });
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  const ta = sim.triggers.areaVisualOf(a)?.tints ?? [];
  const tb = sim.triggers.areaVisualOf(b)?.tints ?? [];
  assert.equal(ta.length, 1);
  near(tb[0]?.value ?? -1, 0.5);
  const red = { r: 255, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  const colours = { get: () => red };
  assert.deepEqual(areaTinted(white, ta, true, colours), red, "all channel at the centre");
  assert.deepEqual(areaTinted(white, tb, true, colours), { r: 255, g: 127, b: 127 }, "half way out");
  assert.deepEqual(areaTinted(white, [{ ...ta[0], main: false }], true, colours), white, "detail only leaves the main half");
});
