// The area triggers' falloff, easing and variance, against the decompile's
// arithmetic as data/ref/gd-areas.md writes it out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { areaEase, areaRandom, areaRate, areaValue, variance } from "../src/triggers/area";

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
