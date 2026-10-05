// The music pulse: the meter, the beat scripts and how objects scale with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MeterPulse, PULSE_REST, ScriptPulse, isMetered, pulseScale } from "../src/audio/pulse";
import type { StringsFile } from "../src/assets/stringTypes";
import { existsSync, readFileSync } from "node:fs";
import { builtPath } from "./helpers";

const near = (got: number, want: number, what: string, eps = 1e-5): void =>
  assert.ok(Math.abs(got - want) < eps, `${what}: ${got} vs ${want}`);

test("the older official tracks are scripted; custom songs and the newer tracks are metered", () => {
  // [PlayLayer::init :106266-106285]
  assert.equal(isMetered({ index: 0 }), false);
  assert.equal(isMetered({ index: 19 }), false);
  assert.equal(isMetered({ index: 20 }), true);
  assert.equal(isMetered({ songId: 467339 }), true);
  assert.equal(isMetered(null), true);
});

test("a metered beat jumps a tenth over the peak, then falls 7% a sample", () => {
  // [sub_2F35E8 :62965-63010]
  const m = new MeterPulse();
  m.enable();
  for (let i = 0; i < 3; i++) m.sample(0);
  near(m.value, PULSE_REST * 0.93 ** 3, "quiet music lets it fall", 1e-4);
  m.sample(0.8);
  near(m.value, 0.9 * 1.1, "a beat");
  m.sample(0.8);
  near(m.value, 0.9 * 1.1 * 0.93, "too soon for another", 1e-4);
});

test("the meter samples sixty times a second, whatever the frame rate", () => {
  // [FMODAudioEngine::update :74799-74820]
  const m = new MeterPulse();
  m.enable();
  let reads = 0;
  for (let i = 0; i < 240; i++) m.step(1 / 240, () => (reads++, 0));
  assert.ok(reads >= 55 && reads <= 61, `${reads} reads in a second`);
});

test("a scripted beat rises over 0.05 s and falls back to rest over 0.2 s", () => {
  // [AudioEffectsLayer::audioStep :329769-329799, triggerEffect :329701-329753]
  const p = new ScriptPulse([0, 1]);
  p.step(0.025, false);
  near(p.value, PULSE_REST + 0.8 * 0.5, "half way up a full-strength beat, a fifth of 4 over rest");
  p.step(0.025, false);
  p.step(0.1, false);
  near(p.value, 0.9 + (PULSE_REST - 0.9) * 0.5, "half way down");
  p.step(0.2, false);
  near(p.value, PULSE_REST, "at rest");
});

test("practice reads the script but beats nothing", () => {
  const p = new ScriptPulse([0, 1, 0.01, 1]);
  p.step(0.02, true);
  p.step(0.02, true);
  near(p.value, PULSE_REST, "still at rest");
});

test("an orb is 0.3 over the pulse up to 1.2, a ranged decoration 0.8-1.2, the rest the pulse", () => {
  // [updateVisibility :96000-96009; RingObject::setRScale :298067-298077]
  near(pulseScale("ring", 0.1), 0.4, "orb at rest");
  near(pulseScale("ring", 1.1), 1.2, "orb at the top");
  near(pulseScale("ranged", 0.1), 0.8, "ranged at rest");
  near(pulseScale("ranged", 1.1), 1.2, "ranged at the top");
  near(pulseScale("plain", 0.6), 0.6, "plain");
});

const STRINGS_PATH = builtPath("assets/strings.json");

test("every scripted official track has a beat script", { skip: existsSync(STRINGS_PATH) ? false : "run `npm run assets` first" }, () => {
  const pulses = (JSON.parse(readFileSync(STRINGS_PATH, "utf8")) as StringsFile).songPulses;
  for (let i = 0; i <= 19; i++) {
    const script = pulses[i];
    assert.ok(script && script.length >= 2 && script.length % 2 === 0, `song ${i}`);
    for (let k = 2; k < script.length; k += 2) assert.ok(script[k] >= script[k - 2], `song ${i} is in time order at ${k}`);
  }
});
