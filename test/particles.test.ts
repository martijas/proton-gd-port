// The custom-particle string, and the emitter it drives.
//
// The 72-field decode is the risky part: a misaligned index does not throw, it
// draws the wrong picture, so these check the decode against every one of the
// thousand definitions the official levels carry rather than against a sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { AtlasSet } from "../src/assets/atlas";
import type { AtlasFile } from "../src/assets/atlasTypes";
import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS, blendAdds } from "../src/engine/gl/spriteBatch";
import { ColorTable, type ColorSource, type PulseAction } from "../src/render/colors";
import {
  CUSTOM_PARTICLE_ID,
  ParticleEmitter,
  ParticleField,
  fadeFactor,
  parseParticleString,
  particleFrameName,
  type ParticleDef,
} from "../src/render/particles";
import { effectiveZLayer, effectiveZOrder } from "../src/triggers/shaderState";
import { defFromPlist } from "../src/render/playerParticles";
import type { ObjectRecord } from "../src/assets/objectTypes";
import { LEVELS_DIR, loadOfficialLevel, OFFICIAL_LEVEL_IDS } from "./helpers";
import { emptyLevel, makeHeader } from "./levelKit";

const LEVELS = existsSync(`${LEVELS_DIR}/1.txt`) ? false : "needs the real install";

/** Every inline definition the official levels place. */
async function allDefinitions(): Promise<string[]> {
  const out: string[] = [];
  for (const id of OFFICIAL_LEVEL_IDS) {
    const level = await loadOfficialLevel(id);
    for (const o of level.objects) {
      if (o.id !== CUSTOM_PARTICLE_ID) continue;
      const raw = o.props[145];
      if (raw) out.push(raw);
    }
  }
  return out;
}

test("the levels' particle definitions all parse", { skip: LEVELS }, async () => {
  const raw = await allDefinitions();
  assert.ok(raw.length > 900, `expected about a thousand definitions, found ${raw.length}`);
  let parsed = 0;
  for (const s of raw) if (parseParticleString(s)) parsed++;
  assert.equal(parsed, raw.length, "every definition the game accepts should parse here too");
});

test("a definition too short to be one is refused", () => {
  assert.equal(parseParticleString(undefined), null);
  assert.equal(parseParticleString(""), null);
  // The game refuses anything at 62 tokens or fewer.
  assert.equal(parseParticleString(new Array(62).fill("0").join("a")), null);
  assert.ok(parseParticleString(new Array(63).fill("1").join("a")), "63 is the minimum it will take");
});

test("the fields the table calls integers really are, across every definition", { skip: LEVELS }, async () => {
  const raw = await allDefinitions();
  // Indices 0, 4-20, 29-32 and 45-58 are read with atoi in the game. If the
  // table were misaligned by one, a float would land in one of these.
  const intIndices = [0, ...range(4, 20), ...range(29, 32), ...range(45, 58)];
  const bad: string[] = [];
  for (const s of raw) {
    const parts = s.split("a");
    for (const i of intIndices) {
      if (i >= parts.length) continue;
      const v = Number(parts[i]);
      if (!Number.isFinite(v) || !Number.isInteger(v)) bad.push(`index ${i} = ${parts[i]}`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} non-integer values in integer fields`);
});

test("the emitter mode is only ever gravity or radius", { skip: LEVELS }, async () => {
  const raw = await allDefinitions();
  const modes = new Set<number>();
  for (const s of raw) {
    const def = parseParticleString(s);
    if (def) modes.add(def.emitterMode);
  }
  assert.deepEqual([...modes].sort(), [...modes].sort().filter((m) => m === 0 || m === 1), `saw modes ${[...modes]}`);
});

test("colour components stay inside zero and one", { skip: LEVELS }, async () => {
  const raw = await allDefinitions();
  let checked = 0;
  for (const s of raw) {
    const def = parseParticleString(s);
    if (!def) continue;
    for (const c of [...def.startColor, ...def.endColor]) {
      assert.ok(c >= 0 && c <= 1, `colour component ${c} is outside 0..1`);
      checked++;
    }
  }
  assert.ok(checked > 1000, "should have checked thousands of components");
});

test("every definition names a texture the sheet has", { skip: LEVELS }, async () => {
  const raw = await allDefinitions();
  const names = new Set<string>();
  for (const s of raw) {
    const def = parseParticleString(s);
    if (def) names.add(particleFrameName(def));
  }
  assert.ok(names.size > 0);
  for (const n of names) {
    // Three digits past index 99: the sheet holds 213 frames and the levels
    // reach 209, so a two-digit-only check would pass while the wrong texture
    // was drawn.
    assert.match(n, /^particle_\d{2,3}_001\.png$/, `${n} is not a particle frame name`);
  }
  const indices = [...names].map((n) => Number(/particle_(\d+)_/.exec(n)?.[1] ?? -1));
  assert.ok(Math.max(...indices) > 99, "the levels use textures past index 99");
});

test("an emitter emits, ages and retires its particles", () => {
  const def = parseParticleString(
    // 20 particles, forever, one second of life, 30 a second, straight up at
    // speed 100, size 10 fading to 0, opaque white fading to clear.
    [
      "20", "-1", "1", "0", "30", "90", "0", "100", "0", "0", "0", "0", "0", "0", "0", "0", "0",
      "10", "0", "0", "0",
      "1", "0", "1", "0", "1", "0", "1", "0",
      "0", "0", "0", "0",
      "1", "0", "1", "0", "1", "0", "0", "0",
      "0", "0", "0", "0",
      "0", "0", "0", "0", "0", "0",
      "0", "0", "0", "0", "0", "0", "1", "0", "0", "0", "0", "0",
    ].join("a"),
  );
  assert.ok(def, "the handwritten definition should parse");
  assert.equal(def.maxParticles, 20);
  assert.equal(def.emissionRate, 30);
  assert.equal(def.textureIndex, 1);
  assert.equal(def.emitterMode, 0);

  const e = new ParticleEmitter(def, 100, 200, 0);
  assert.equal(e.count, 0);
  e.step(0.5, 1000);
  assert.ok(e.count > 0, "half a second at thirty a second should have emitted");
  const peak = e.count;
  // Every particle lives exactly a second, so two more seconds with nothing new
  // emitted has to empty it.
  const drained = new ParticleEmitter(def, 100, 200, 0);
  drained.step(0.1, 1000);
  assert.ok(drained.count > 0);
  for (let i = 0; i < 30; i++) drained.step(0.1, 0);
  assert.equal(drained.count, 0, "particles have to die of old age");
  assert.ok(peak <= e.capacity, "an emitter never exceeds its own pool");
});

test("the live budget is shared, so one emitter cannot starve the rest", () => {
  const def = parseParticleString(new Array(72).fill("0").join("a"));
  assert.ok(def);
  const hungry = { ...def, maxParticles: 500, emissionRate: 10000, life: 10, duration: -1 };
  const e = new ParticleEmitter(hungry, 0, 0, 0);
  const left = e.step(1, 25);
  assert.equal(left, 0, "the budget is spent");
  assert.ok(e.count <= 25, `emitted ${e.count} with a budget of 25`);
});

// --- the game's additions ----------------------------------------------------

/** A 72-token definition: one particle going right at 100, a long life, no noise, then `over`. */
function customString(over: Record<number, number> = {}): string {
  const t = new Array(72).fill(0);
  t[0] = 1; // max particles
  t[1] = -1; // duration: for ever
  t[2] = 10; // life
  t[4] = 1000; // emission rate
  t[7] = 100; // speed
  t[17] = 10; // start size
  t[29] = 10; // end size
  for (const k of [21, 23, 25, 27, 33, 35, 37, 39]) t[k] = 1; // white, opaque
  for (const [k, v] of Object.entries(over)) t[Number(k)] = v;
  return t.join("a");
}

function custom(over: Record<number, number> = {}): ParticleDef {
  const def = parseParticleString(customString(over));
  assert.ok(def);
  return def;
}

function baked(e: ParticleEmitter): { x: number; y: number; rgba: number[] } {
  const out = new Float32Array(16);
  const bytes = new Uint8Array(out.buffer);
  e.bake(out, bytes, 0, { u0: 0, v0: 0, du: 1, dv: 1, sheet: 0, rotated: 0 });
  return { x: out[4], y: out[5], rgba: [bytes[40], bytes[41], bytes[42], bytes[43]] };
}

test("tokens 56 to 71 are read", () => {
  const def = custom({ 56: 1, 58: 1, 59: 2, 60: 0.5, 61: 3, 62: 1, 63: 1, 66: 1, 67: 1, 68: 4, 69: 0.25, 70: 5, 71: 0.75 });
  assert.equal(def.dynamicRotation, true);
  assert.equal(def.uniformColor, true);
  assert.deepEqual([def.frictionP, def.frictionPVar, def.respawn, def.respawnVar], [2, 0.5, 3, 1]);
  assert.equal(def.orderSensitive, true);
  assert.deepEqual([def.startRGBVarSync, def.endRGBVarSync], [true, true]);
  assert.deepEqual([def.frictionS, def.frictionSVar, def.frictionR, def.frictionRVar], [4, 0.25, 5, 0.75]);
});

test("friction takes a share of the speed each second, after the move", () => {
  // Ten steps of 0.1 s at 100 is 100 units; with friction 2 each step keeps
  // 0.8 of the speed: 10 × (1 - 0.8^10) / 0.2 = 44.631 units.
  // [CCParticleSystem::update :845769-845790]
  const plain = new ParticleEmitter(custom(), 0, 0, 1);
  const rough = new ParticleEmitter(custom({ 59: 2 }), 0, 0, 1);
  for (let i = 0; i < 10; i++) {
    plain.step(0.1, 10);
    rough.step(0.1, 10);
  }
  assert.ok(Math.abs(baked(plain).x - 100) < 1e-3, `${baked(plain).x}`);
  assert.ok(Math.abs(baked(rough).x - 44.6313) < 1e-3, `${baked(rough).x}`);
});

test("friction on the speed does nothing to a radius emitter", () => {
  // A quarter turn a second at radius 100: after a second the particle has
  // gone from (-100, 0) to (0, -100) either way, because radius mode never
  // reads the speed friction damps. [CCParticleSystem::update :845769-845775
  //  damps +108/+112; the radius branch :845620-845705 reads +124 to +144]
  const radius = { 51: 1, 45: 100, 47: 100, 49: 90 };
  const plain = new ParticleEmitter(custom(radius), 0, 0, 1);
  const rough = new ParticleEmitter(custom({ ...radius, 59: 2 }), 0, 0, 1);
  for (let i = 0; i < 10; i++) {
    plain.step(0.1, 10);
    rough.step(0.1, 10);
  }
  const a = baked(plain);
  const b = baked(rough);
  assert.ok(Math.abs(a.x) < 1e-3 && Math.abs(a.y + 100) < 1e-3, `${a.x}, ${a.y}`);
  assert.ok(Math.abs(b.x - a.x) < 1e-9 && Math.abs(b.y - a.y) < 1e-9, `${b.x}, ${b.y}`);
});

test("a fade scales the alpha, and an additive particle's colour as well", () => {
  // [CCParticleSystemQuad::updateQuadWithParticle :848040-848063]
  assert.equal(fadeFactor(0.1, 0.9, 0.5, 0), 0.2);
  assert.equal(fadeFactor(0.6, 0.2, 0.5, 0.4), 0.5);
  assert.equal(fadeFactor(0.3, 0.7, 0.2, 0.5), 1);
  const normal = new ParticleEmitter(custom({ 41: 1 }), 0, 0, 1);
  const additive = new ParticleEmitter(custom({ 41: 1, 53: 1 }), 0, 0, 1);
  for (const e of [normal, additive]) for (let i = 0; i < 5; i++) e.step(0.1, 10);
  // Half a second into a one-second fade-in (the first step emits at age 0).
  assert.deepEqual(baked(normal).rgba, [255, 255, 255, 127]);
  assert.deepEqual(baked(additive).rgba, [127, 127, 127, 127]);
});

test("an emitter that runs out waits on screen for its restarts, and a burst fills it at once", () => {
  // Duration 0 and rate -1: stopped when it comes on screen, started by the
  // synced animation, then five particles at once and stopped again; the
  // next restart comes a life later. [claimParticle :306373-306379;
  //  updateSyncedAnimation :301799-301846; update :845480-845502]
  const e = new ParticleEmitter(custom({ 0: 5, 1: 0, 2: 1, 4: -1 }), 0, 0, 1);
  e.claim();
  e.step(1 / 60, 100);
  assert.equal(e.count, 0, "stopped until its first restart");
  e.sync(0);
  e.step(1 / 60, 100);
  assert.equal(e.count, 0, "the first restart is due now, and goes the frame after");
  e.sync(0.01);
  e.step(1 / 60, 100);
  assert.equal(e.count, 5, "one full burst");
  assert.equal(e.running, false);
  e.sync(0.02);
  e.sync(1.02);
  assert.equal(e.running, false, "a life after the last look, not yet past it");
  e.sync(1.03);
  assert.equal(e.running, true);
});

test("an emitter that waits for an Animate trigger starts only when one reaches it", () => {
  const e = new ParticleEmitter(custom({ 0: 5, 1: 0, 2: 1, 4: -1 }), 0, 0, 1, { animateOnTrigger: true });
  e.claim();
  e.sync(0);
  e.sync(5);
  assert.equal(e.running, false);
  e.animate();
  e.sync(5.1);
  assert.equal(e.running, true);
});

test("an Animate trigger starts an emitter with key 123 again even when it runs for ever", () => {
  // The trigger calls updateSyncedAnimation itself, which asks only for key
  // 123 and the pending start: the particles out are cleared and it runs
  // from the top. [EnhancedGameObject::triggerAnimation :620435-620442;
  //  ParticleGameObject::updateSyncedAnimation :301797-301804]
  const e = new ParticleEmitter(custom(), 0, 0, 1, { animateOnTrigger: true });
  e.claim();
  for (let i = 0; i < 3; i++) {
    e.sync(i / 60);
    e.step(1 / 60, 100);
  }
  assert.equal(e.count, 1, "it runs as soon as it is on screen");
  e.animate();
  e.sync(0.1);
  assert.equal(e.count, 0, "started again, its particles gone");
  assert.equal(e.running, true);
  e.sync(0.2);
  e.step(1 / 60, 100);
  assert.equal(e.count, 1, "and emitting");
});

test("a uniform colour runs the object's main colour to its detail colour", () => {
  // [update :845707-845725; applyParticleSettings :306273-306299]
  const e = new ParticleEmitter(custom({ 58: 1, 2: 1 }), 0, 0, 1);
  e.claim({ main: { r: 255, g: 0, b: 0 }, detail: { r: 0, g: 0, b: 255 }, useForRamp: false, useForUniform: true, blending: false });
  for (let i = 0; i < 5; i++) e.step(0.1, 10);
  // Half its life gone.
  assert.deepEqual(baked(e).rgba.slice(0, 3), [127, 0, 127]);
});

const RED = { r: 255, g: 0, b: 0 };
const GREEN = { r: 0, g: 255, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

test("key 147: new object colours reach the particles already out", () => {
  // The object's colours go straight into the shared ramp, which update
  // reads every step. [ParticleGameObject::setObjectColor :298150-298156,
  //  setChildColor :297908-297914; update :845707-845725]
  const e = new ParticleEmitter(custom({ 58: 1, 2: 1 }), 0, 0, 1);
  e.claim({ main: RED, detail: BLUE, useForRamp: false, useForUniform: true, blending: false });
  for (let i = 0; i < 5; i++) e.step(0.1, 10);
  assert.deepEqual(baked(e).rgba.slice(0, 3), [127, 0, 127]);
  e.recolour({ main: GREEN, detail: GREEN, useForRamp: false, useForUniform: true, blending: false });
  // The next step reads the ramp; a frozen one (0) steps nothing.
  e.step(0.001, 10);
  assert.deepEqual(baked(e).rgba.slice(0, 3), [0, 255, 0]);
});

test("key 146: new object colours reach new particles, and the alphas stay", () => {
  // setStartColor and setEndColor with the rgb given and the alpha the
  // emitter already had. [ParticleGameObject::setObjectColor :298136-298148,
  //  setChildColor :297894-297906]
  const e = new ParticleEmitter(custom({ 0: 2, 4: 1, 27: 0.5, 39: 0.5 }), 0, 0, 1);
  e.claim({ main: RED, detail: RED, useForRamp: true, useForUniform: false, blending: false });
  e.step(1.01, 10);
  e.recolour({ main: GREEN, detail: GREEN, useForRamp: true, useForUniform: false, blending: false });
  e.step(1, 10);
  assert.equal(e.count, 2);
  const out = new Float32Array(2 * INSTANCE_FLOATS);
  const bytes = new Uint8Array(out.buffer);
  e.bake(out, bytes, 0, { u0: 0, v0: 0, du: 1, dv: 1, sheet: 0, rotated: 0 });
  assert.deepEqual([...bytes.slice(40, 44)], [255, 0, 0, 127], "the one already out keeps its colour");
  assert.deepEqual([...bytes.slice(INSTANCE_BYTES + 40, INSTANCE_BYTES + 44)], [0, 255, 0, 127], "a new one takes the new one");
});

test("an emitter on screen reads its object's colours every frame, group pulses first, then its hue shift", () => {
  // [GameObject::colorForMode :173028-173089: groupColor :173063, then
  //  transformColor :173079]
  const level = emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString({ 58: 1 }), 147: "1" } }]);
  const object = level.objects[level.objects.length - 1];
  object.baseColor = 10;
  object.groups = [5];
  let channel10 = RED;
  let pulses: PulseAction[] = [];
  const colors: ColorSource = {
    get: (id) => ({ ...(id === 10 ? channel10 : { r: 255, g: 255, b: 255 }), a: 1, blending: false }),
    pulsesForGroup: (group) => (group === 5 && pulses.length > 0 ? pulses : undefined),
  };
  const field = new ParticleField(level, particleAtlas());
  const view = { x0: 0, y0: -400, x1: 600, y1: 400 };
  const rgb = (levelTime: number): number[] => {
    const { data, count } = field.update(1 / 60, view, { levelTime, colors, animationsOf: () => 0 });
    assert.equal(count, 1);
    return [...new Uint8Array(data.buffer).slice(40, 43)];
  };
  assert.deepEqual(rgb(0), [255, 0, 0]);
  channel10 = GREEN;
  assert.deepEqual(rgb(1 / 60), [0, 255, 0], "a colour trigger reaches the particles already out");
  pulses = [{
    target: 5, fadeIn: 0, hold: 1, fadeOut: 0, elapsed: 0, value: 1, mode: 2, colour: { r: 255, g: 255, b: 0 },
    hsv: { h: 0, s: 1, v: 1, sChecked: false, vChecked: false }, copyChannel: 0, mainOnly: false, detailOnly: false,
    animateHsv: false,
  }];
  object.baseHsv = { h: 180, s: 1, v: 1, sChecked: false, vChecked: false };
  assert.deepEqual(rgb(2 / 60), [0, 0, 255], "the pulse's yellow, then turned half way round the hue circle");
});

test("a synced colour variance moves all three channels by the red one's amount", () => {
  // [initParticle :844795-844883]
  const e = new ParticleEmitter(custom({ 21: 0.25, 23: 0.25, 25: 0.25, 22: 0.5, 66: 1, 33: 0.25, 35: 0.25, 37: 0.25 }), 0, 0, 7);
  e.step(0.001, 10);
  const [r, g, b] = baked(e).rgba;
  assert.ok(r === g && g === b, `${r} ${g} ${b}`);
});

test("the field bakes its emitters one layer at a time, each in its object's layer", () => {
  // Placed T1 first and B5 second; drawn B5 first. An emitter with no key 24,
  // or with key 24 = 0, takes its type's default, which the scene hands in
  // (T1 for 2065) by the same rule as the draw list.
  // [ParticleGameObject::addMainSpriteToParent :301723-301745;
  //  getObjectZLayer :169016-169023]
  const level = emptyLevel([
    { id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString(), 24: "5" } },
    { id: CUSTOM_PARTICLE_ID, x: 330, y: 100, props: { 145: customString(), 24: "-5" } },
    { id: CUSTOM_PARTICLE_ID, x: 360, y: 100, props: { 145: customString() } },
    { id: CUSTOM_PARTICLE_ID, x: 390, y: 100, props: { 145: customString(), 24: "0" } },
  ]);
  for (const o of level.objects) o.zLayer = o.props[24] !== undefined ? Number(o.props[24]) : null;
  const view = { x0: 0, y0: -400, x1: 900, y1: 400 };
  const field = new ParticleField(level, particleAtlas(), (o) => effectiveZLayer(o.zLayer, 5));
  const { data, count } = field.update(1 / 60, view, { levelTime: 0, colors: null, animationsOf: () => 0 });
  assert.equal(count, 4);
  assert.deepEqual([...field.layerRuns], [1, 0, 0, 0, 0, 1, 0, 0, 0], "key 24 = 0 is T1, not B2");
  assert.ok(Math.abs(data[4] - 330) < 5, `the B5 emitter's particle comes first (x ${data[4]})`);
  // Each at its layer's container: B5's at -1260, T1's at 320.
  // [setupLayers :435227-435275; batchNodes.containerZ]
  assert.deepEqual([...field.runZ.slice(0, field.runs)], [-1260, 320]);
  assert.deepEqual([...field.runStart.slice(0, field.runs)], [0, 1]);
  assert.deepEqual([...field.runCount.slice(0, field.runs)], [1, 3]);
  assert.deepEqual([field.layerRunFirst[5], field.layerRuns[5]], [1, 1]);

  // Without a default handed in, both count as layer 0: B2.
  const bare = new ParticleField(level, particleAtlas());
  bare.update(1 / 60, view, { levelTime: 0, colors: null, animationsOf: () => 0 });
  assert.deepEqual([...bare.runZ.slice(0, bare.runs)], [-1260, -360, 320]);
  assert.deepEqual([...bare.runCount.slice(0, bare.runs)], [1, 2, 1]);
});

test("a container draws its systems by their objects' z order, then in the order they came", () => {
  // Each goes in with addChild(container, system, getObjectZOrder()); key 25
  // = 0 is the type's own, which the scene hands in.
  // [ParticleGameObject::addMainSpriteToParent :301736-301759]
  const level = emptyLevel([
    { id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString(), 25: "5" } },
    { id: CUSTOM_PARTICLE_ID, x: 330, y: 100, props: { 145: customString(), 25: "-3" } },
    { id: CUSTOM_PARTICLE_ID, x: 360, y: 100, props: { 145: customString(), 25: "5" } },
    { id: CUSTOM_PARTICLE_ID, x: 390, y: 100, props: { 145: customString() } },
  ]);
  for (const o of level.objects) o.zOrder = o.props[25] !== undefined ? Number(o.props[25]) : null;
  const field = new ParticleField(level, particleAtlas(), () => 5, (o) => effectiveZOrder(o.zOrder, 1));
  const { data, count } = field.update(1 / 60, { x0: 0, y0: -400, x1: 900, y1: 400 }, { levelTime: 0, colors: null, animationsOf: () => 0 });
  assert.equal(count, 4);
  const xs = [0, 1, 2, 3].map((i) => Math.round(data[i * INSTANCE_FLOATS + 4] / 30) * 30);
  assert.deepEqual(xs, [330, 390, 300, 360], "-3, the default 1, then the two at 5 as placed");
  assert.deepEqual([field.runs, field.runZ[0], field.runCount[0]], [1, 320, 4], "all in T1's container: one run");
});

test("a hidden emitter (key 135) never claims a system", () => {
  // Showing the object is the only place it claims one, and a hidden object
  // is never shown in play. [GameObject::setVisible :164667-164690;
  //  activateObject :169451-169475]
  const shown = new ParticleField(emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString() } }]), particleAtlas());
  assert.equal(shown.emitterCount, 1);
  const hidden = new ParticleField(
    emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString(), 135: "1" } }]),
    particleAtlas(),
  );
  assert.equal(hidden.emitterCount, 0);
});

test("a Spawn Particle trigger's system is a one-shot copy, even of a hidden object, gone once spent", () => {
  // Duration -1 becomes 0: one step's burst, then the particles live out
  // their 0.5 s and the system goes. [gdp spawnParticleTrigger :431365-431412]
  const level = emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 2000, props: { 145: customString({ 0: 5, 2: 0.5, 4: -1 }), 135: "1" } }]);
  const field = new ParticleField(level, particleAtlas());
  assert.equal(field.emitterCount, 0, "hidden: no placed system");
  const view = { x0: 0, y0: -400, x1: 900, y1: 400 };
  const frame = () => field.update(1 / 10, view, { levelTime: 0, colors: null, animationsOf: () => 0 });
  field.spawn(level.objects[level.objects.length - 1], 450, 100, 0, 1, 1);
  const first = frame();
  assert.equal(first.count, 5, "the whole burst");
  assert.ok(Math.abs(first.data[4] - 450) < 30, `at the spawn point (x ${first.data[4]})`);
  for (let i = 0; i < 5; i++) frame();
  assert.equal(frame().count, 0, "spent");
});

test("an emitter in a group a toggle switched off hands its system back", () => {
  // [GJBaseGameLayer::preUpdateVisibility :452902]
  const level = emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString() } }]);
  const index = level.objects.length - 1;
  const field = new ParticleField(level, particleAtlas());
  const view = { x0: 0, y0: -400, x1: 900, y1: 400 };
  const on = field.update(1 / 60, view, { levelTime: 0, colors: null, animationsOf: () => 0 });
  assert.equal(on.count, 1);
  const off = field.update(1 / 60, view, { levelTime: 0, colors: null, animationsOf: () => 0, objectDisabled: (i) => i === index });
  assert.equal(off.count, 0);
});

test("an emitter on its object's colours adds while the object blends, once its blending changes", () => {
  // Token 53 stands until the object's blend flag first changes; from then
  // the flag decides. [ParticleGameObject::blendModeChanged :297285-297296;
  //  GameObject::addMainSpriteToParent :169317-169322]
  const e = new ParticleEmitter(custom({ 53: 0 }), 0, 0, 1);
  e.claim({ main: RED, detail: RED, useForRamp: true, useForUniform: false, blending: false });
  e.step(0.1, 10);
  e.objectBlend(false);
  assert.equal(e.additive, false, "never blended: the definition's normal blend");
  e.objectBlend(true);
  assert.equal(e.additive, true);
  const out = new Float32Array(16);
  const bytes = new Uint8Array(out.buffer);
  e.bake(out, bytes, 0, { u0: 0, v0: 0, du: 1, dv: 1, sheet: 0, rotated: 0 });
  // Made normal, it kept the premultiplied colour of a normal system, so it
  // adds the way a sprite in an additive batch does.
  assert.equal(bytes[46], BLEND.ADD_SPRITE);
  e.objectBlend(false);
  assert.equal(e.additive, false, "a colour trigger turned it off again");
  const adds = new ParticleEmitter(custom({ 53: 1 }), 0, 0, 1);
  adds.objectBlend(false);
  assert.equal(adds.additive, true, "an object that never blended leaves an additive definition alone");
  adds.objectBlend(true);
  adds.objectBlend(false);
  assert.equal(adds.additive, false, "but once it has, the object decides");
});

test("the field reads an emitter's object's blending from its channels", () => {
  const header = makeHeader();
  header.colors.set(5, { id: 5, r: 255, g: 255, b: 255, opacity: 1, blending: true, copyId: 0, copyHsv: null, copyOpacity: false, playerColor: 0 });
  const table = ColorTable.resolve(header);
  const level = emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString({ 53: 0 }), 147: "1", 21: "5" } }]);
  for (const o of level.objects) if (o.props[21] !== undefined) o.baseColor = Number(o.props[21]);
  const field = new ParticleField(level, particleAtlas());
  const view = { x0: 0, y0: -400, x1: 900, y1: 400 };
  const { data, count } = field.update(1 / 60, view, { levelTime: 0, colors: table, animationsOf: () => 0 });
  assert.equal(count, 1);
  assert.equal(new Uint8Array(data.buffer)[46], BLEND.ADD_SPRITE, "channel 5 blends, so the particles add");
});

test("a respawn starts the field over without replaying the Animate triggers before it", () => {
  // One emitter that waits for an Animate trigger (key 123) and bursts five
  // particles when one comes. Going back in time is a practice respawn: the
  // count the checkpoint kept is history, and only a new trigger starts it.
  const def = customString({ 0: 5, 1: 0, 2: 1, 4: -1 });
  const level = emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: def, 123: "1" } }]);
  const field = new ParticleField(level, particleAtlas());
  const index = level.objects.length - 1;
  const view = { x0: 0, y0: -400, x1: 600, y1: 400 };
  let count = 0;
  const frame = (levelTime: number) =>
    field.update(1 / 60, view, { levelTime, colors: null, animationsOf: (i) => (i === index ? count : 0) }).count;
  assert.equal(frame(0), 0, "waiting");
  count = 1;
  assert.equal(frame(1), 5, "the Animate trigger started it");
  assert.equal(frame(0.5), 0, "back in time: over, and not started again");
  count = 2;
  assert.equal(frame(0.52), 5, "a new Animate trigger starts it");
});

/** An atlas holding only particle texture 0, the one customString's token 57 names. */
function particleAtlas(): AtlasSet {
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [{ name: "t", image: "t.png", w: 64, h: 64, frames: [{ n: "particle_00_001.png", x: 0, y: 0, w: 32, h: 32 }] }],
    frames: { "particle_00_001.png": [0, 0] },
  };
  return new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// --- following the object ---------------------------------------------------------

/** One particle a step after the emitter came on screen, as the field draws it. */
function fieldParticle(placed: { rotation?: number; flipX?: boolean; scaleX?: number; props?: Record<number, string> }, over: Record<number, number>) {
  const level = emptyLevel([
    { id: CUSTOM_PARTICLE_ID, x: 300, y: 100, rotation: placed.rotation, flipX: placed.flipX, scaleX: placed.scaleX, props: { 145: customString(over), ...placed.props } },
  ]);
  const index = level.objects.length - 1;
  const field = new ParticleField(level, particleAtlas());
  const view = { x0: 0, y0: -400, x1: 900, y1: 400 };
  let transform: Float64Array | null = null;
  const frame = (levelTime: number) => {
    const { data, count } = field.update(1 / 10, view, {
      levelTime,
      colors: null,
      animationsOf: () => 0,
      objectTransform: (i, out) => {
        if (i !== index || !transform) return false;
        out.set(transform);
        return true;
      },
    });
    return { count, x: data[4], y: data[5], m: [...data.slice(0, 4)] };
  };
  return { frame, move: (m: number[]) => (transform = Float64Array.from(m)) };
}

test("a grouped emitter's particles turn, scale and move with its object", () => {
  // Position type 2: the particle system is a node turned and scaled with the
  // object, flips as negative scales, and moved with it. A particle sent right
  // at 100 a second is 10 right after a tenth of a second; turned 90° (clockwise)
  // it is 10 below, and it follows a move of the group, particles out included.
  // [GameObject::setRotation :164465-164492, setScaleX :164354-164390,
  //  setPosition :164602-164627; ParticleGameObject::applyParticleSettings
  //  :306209-306232]
  const plain = fieldParticle({}, { 52: 2 }).frame(0);
  assert.equal(plain.count, 1);
  assert.ok(Math.abs(plain.x - 310) < 1e-3 && Math.abs(plain.y - 100) < 1e-3, `${plain.x}, ${plain.y}`);
  const turned = fieldParticle({ rotation: 90 }, { 52: 2 }).frame(0);
  assert.ok(Math.abs(turned.x - 300) < 1e-3 && Math.abs(turned.y - 90) < 1e-3, `${turned.x}, ${turned.y}`);
  const flipped = fieldParticle({ flipX: true, scaleX: 2 }, { 52: 2 }).frame(0);
  assert.ok(Math.abs(flipped.x - 280) < 1e-3, `flipped and doubled: ${flipped.x}`);
  assert.ok(Math.abs(flipped.m[0] + 10) < 1e-3, `the sprite is doubled and mirrored too: ${flipped.m[0]}`);
  const moving = fieldParticle({}, { 52: 2 });
  moving.frame(0);
  moving.move([1, 0, 0, 1, 0, 50, 0, 1, 1]);
  const after = moving.frame(0.1);
  assert.ok(Math.abs(after.x - 320) < 1e-3 && Math.abs(after.y - 150) < 1e-3, `carried: ${after.x}, ${after.y}`);
});

test("a relative emitter sends its particles off turned with its object, and leaves them where they are", () => {
  // Position type 1: the node never turns; the emission angle is the
  // definition's less the object's turn, and a particle out stays put when the
  // emitter moves on. [ParticleGameObject::updateParticleAngle :306105-306146;
  //  applyParticleSettings :306209-306232]
  const turned = fieldParticle({ rotation: 90 }, { 52: 1 }).frame(0);
  assert.ok(Math.abs(turned.x - 300) < 1e-3 && Math.abs(turned.y - 90) < 1e-3, `${turned.x}, ${turned.y}`);
  assert.deepEqual(turned.m.map((v) => Math.round(v) || 0), [5, 0, 0, 5], "the sprite is not turned");
  const moving = fieldParticle({}, { 52: 1, 0: 1 });
  moving.frame(0);
  moving.move([1, 0, 0, 1, 0, 50, 0, 1, 1]);
  const after = moving.frame(0.1);
  assert.ok(Math.abs(after.x - 320) < 1e-3 && Math.abs(after.y - 100) < 1e-3, `left behind: ${after.x}, ${after.y}`);
});

test("a relative emitter takes its object's scale only from a scale trigger while on screen", () => {
  // The claim leaves the node at scale 1; setScaleX and setScaleY while it is
  // claimed load the definition's sizes, spread and speed times the new
  // scale. [applyParticleSettings :306214-306216; ParticleGameObject::setScaleX
  //  :306573-306581 → updateParticleScale :306486-306502 → loadScaledDefaults
  //  :846625-846642]
  const big = fieldParticle({ scaleX: 3 }, { 52: 1 }).frame(0);
  assert.ok(Math.abs(big.x - 310) < 1e-3, `the object's own scale does nothing: ${big.x}`);
  const scaled = fieldParticle({}, { 52: 1, 2: 0.15 });
  scaled.frame(0);
  scaled.move([2, 0, 0, 2, -300, -100, 0, 2, 2]);
  scaled.frame(1);
  const next = scaled.frame(1.1);
  assert.ok(Math.abs(next.x - 320) < 1e-3, `twice the speed after a scale trigger: ${next.x}`);
  assert.deepEqual(next.m.map((v) => Math.round(v) || 0), [10, 0, 0, 10], "and twice the size");
});

// --- the systems an object's type carries ------------------------------------------

/** portalEffect02 as the cube portal would carry it: a 40-unit ring of squares falling inward, grouped with the portal. */
function swirl(): ParticleDef {
  return defFromPlist({
    maxParticles: 30,
    duration: -1,
    particleLifespan: 0.6,
    emitterType: 1,
    maxRadius: 40,
    minRadius: 0,
    startParticleSize: 6,
    finishParticleSize: 1,
    startColorRed: 1,
    startColorGreen: 1,
    startColorAlpha: 0.5,
    finishColorRed: 1,
    finishColorGreen: 1,
    finishColorAlpha: 1,
    blendFuncDestination: 1,
  });
}

test("a portal carries its own particle system, at its offset, in the colours customSetup gave it", () => {
  // The spider portal's: portalEffect02, grouped, 5 units behind, purple.
  // [gdp GameObject::customSetup :177390-177409; createAndAddParticle
  //  :167739-167766; setPosition :164602-164627]
  const level = emptyLevel([{ id: 1331, x: 300, y: 100 }]);
  const record = {
    k: "portal",
    hb: null,
    src: "table",
    p: { hb: "none", art: "manual", z: "none" },
    zl: 5,
    pt: { e: "portalEffect02", pos: 2, z: 4, s: [0.784314, 0, 1, 1], en: [0.784314, 0, 1, 1], o: [-5, 0] },
  } as unknown as ObjectRecord;
  const field = new ParticleField(level, particleAtlas(), (o) => effectiveZLayer(o.zLayer, 5));
  const quad = { u0: 0, v0: 0, du: 1, dv: 1, sheet: 13, rotated: 0 };
  field.addBuiltIn(level, (id) => (id === 1331 ? record : undefined), (name) => (name === "portalEffect02" ? { def: swirl(), texture: "square.png" } : null), () => quad);
  assert.equal(field.emitterCount, 1);
  const view = { x0: 0, y0: -400, x1: 900, y1: 400 };
  const { data, count } = field.update(1 / 30, view, { levelTime: 0, colors: null, animationsOf: () => 0 });
  assert.ok(count > 0, "it runs on screen");
  // At its tag, 4, in the object layer itself: over all of B1 and under all
  // of T1, though the portal is in T1. [GJBaseGameLayer::createParticle
  //  :458906-458908 → claimParticle :431656-431700]
  assert.deepEqual([field.runs, field.runZ[0], field.runCount[0]], [1, 4, count]);
  assert.deepEqual([field.layerRunFirst[4], field.layerRuns[4], field.layerRuns[5]], [0, 1, 0], "drawn with B1");
  const bytes = new Uint8Array(data.buffer);
  assert.ok(Math.abs(bytes[40] - 200) <= 1 && bytes[41] === 0 && bytes[42] === 255, `purple, got ${bytes[40]},${bytes[41]},${bytes[42]}`);
  for (let i = 0; i < count; i++) {
    const x = data[i * INSTANCE_FLOATS + 4];
    const y = data[i * INSTANCE_FLOATS + 5];
    assert.ok(Math.hypot(x - 295, y - 100) <= 61, `a particle within the ring about (295, 100), got (${x}, ${y})`);
  }
  // A second call adds nothing.
  field.addBuiltIn(level, () => record, () => ({ def: swirl(), texture: "square.png" }), () => quad);
  assert.equal(field.emitterCount, 1);
});

test("an object with +669 hands its own colour to its system: full to start, clear to end", () => {
  // The yellow orb's ring takes the orb's colour as it comes on screen.
  // [gdp GameObject::claimParticle :167700-167712 → updateParticleColor
  //  :163689-163725]
  const level = emptyLevel([{ id: 36, x: 300, y: 100, props: { 21: "10" } }]);
  level.objects[level.objects.length - 1].baseColor = 10;
  const record = {
    k: "orb",
    hb: null,
    src: "table",
    p: { hb: "none", art: "manual", z: "none" },
    pt: { e: "ringEffect", pos: 2, c: 1 },
  } as unknown as ObjectRecord;
  const colors: ColorSource = { get: (id) => (id === 10 ? { r: 0, g: 255, b: 0, a: 1, blending: false } : { r: 255, g: 255, b: 255, a: 1, blending: false }) };
  const field = new ParticleField(level, particleAtlas());
  field.addBuiltIn(level, (id) => (id === 36 ? record : undefined), () => ({ def: swirl(), texture: "square.png" }), () => ({ u0: 0, v0: 0, du: 1, dv: 1, sheet: 13, rotated: 0 }));
  const { data, count } = field.update(1 / 30, { x0: 0, y0: -400, x1: 900, y1: 400 }, { levelTime: 0, colors, animationsOf: () => 0 });
  assert.ok(count > 0, "a particle is out after a thirtieth of a second");
  const bytes = new Uint8Array(data.buffer);
  assert.deepEqual([bytes[40], bytes[41], bytes[42]], [0, 255, 0], "the orb's green");
  assert.ok(bytes[43] > 150, `and nearly opaque, fresh out (${bytes[43]})`);
});

// --- the object's opacity --------------------------------------------------------

/** A cube portal with its own swirl, on its own in a level, and a field ready to step it. */
function portalField(props: Record<number, string> = {}): ParticleField {
  const level = emptyLevel([{ id: 12, x: 300, y: 100, props }]);
  const placed = level.objects[level.objects.length - 1];
  if (props[21] !== undefined) placed.baseColor = Number(props[21]);
  if (props[57] !== undefined) placed.groups = props[57].split(".").map(Number);
  const record = {
    k: "portal",
    hb: null,
    src: "table",
    p: { hb: "none", art: "manual", z: "none" },
    pt: { e: "portalEffect03", pos: 2, z: 4, o: [-5, 0] },
  } as unknown as ObjectRecord;
  const field = new ParticleField(level, particleAtlas());
  field.addBuiltIn(level, (id) => (id === 12 ? record : undefined), () => ({ def: swirl(), texture: "square.png" }), () => ({ u0: 0, v0: 0, du: 1, dv: 1, sheet: 13, rotated: 0 }));
  return field;
}

const ON_SCREEN = { x0: 0, y0: -400, x1: 900, y1: 400 };

test("an object's own system stops at an opacity of 50 or less, and starts again over it", () => {
  // Faded to nothing by an Alpha trigger, the spider portal in Dash stops
  // throwing its swirl; what is out finishes. The cutoff is on the opacity
  // its object is shown at, times its colour's and its groups'.
  // [GameObject::setOpacity :167614-167703 → updateParticleOpacity
  //  :165124-165150]
  const field = portalField({ 57: "7" });
  let fade = 50.5 / 255;
  let group = 1;
  const frame = (): number =>
    field.update(1 / 30, ON_SCREEN, { levelTime: 0, colors: null, animationsOf: () => 0, objectFade: () => fade, groupAlphaOf: (g) => (g === 7 ? group : 1) }).count;
  for (let i = 0; i < 10; i++) assert.equal(frame(), 0, "shown at 50, it never starts");
  fade = 51.5 / 255;
  frame();
  assert.ok(frame() > 0, "at 51 it runs");
  fade = 1;
  for (let i = 0; i < 10; i++) frame();
  const out = frame();
  // 255 × 0.19 is 48: stopped. Nothing new, and the lives (at most a second) run out.
  group = 0.19;
  assert.ok(frame() <= out, "nothing new once its group fades");
  for (let i = 0; i < 40; i++) frame();
  assert.equal(frame(), 0, "and what was out has finished");
  group = 0.21;
  frame();
  assert.ok(frame() > 0, "over 50 again, it starts again");
});

test("an object's own system goes by its colour's opacity, rounded as the game rounds it", () => {
  // Channel opacity as a byte, whole over 249, else times 0.004: 0.2 is 51,
  // 51 × 0.004 × 255 is 52 and runs; 0.19 is 48, then 48 and stops.
  // [GameObject::opacityModForMode :172788-172808]
  const countAt = (a: number): number => {
    const field = portalField({ 21: "5" });
    const colors: ColorSource = { get: (id) => ({ r: 255, g: 255, b: 255, a: id === 5 ? a : 1, blending: false }) };
    let count = 0;
    for (let i = 0; i < 10; i++) count = field.update(1 / 30, ON_SCREEN, { levelTime: 0, colors, animationsOf: () => 0, objectFade: () => 1 }).count;
    return count;
  };
  assert.equal(countAt(0.19), 0);
  assert.ok(countAt(0.2) > 0);
  assert.ok(countAt(0.99) > 0, "249 and up counts as whole");
});

test("an object's own system off the screen's edge, where its object is faded out, does not run", () => {
  // The edge fade is what the object is shown at: 0 past the edge. Without
  // a draw list to ask, an object counts as shown in full.
  const faded = portalField();
  let count = 0;
  for (let i = 0; i < 10; i++) count = faded.update(1 / 30, ON_SCREEN, { levelTime: 0, colors: null, animationsOf: () => 0, objectFade: () => 0 }).count;
  assert.equal(count, 0);
  const shown = portalField();
  for (let i = 0; i < 10; i++) count = shown.update(1 / 30, ON_SCREEN, { levelTime: 0, colors: null, animationsOf: () => 0 }).count;
  assert.ok(count > 0);
});

test("a Custom Particles object's opacity dims every particle it has out, and never stops it", () => {
  // Its own updateParticleOpacity is empty; its main opacity becomes the
  // system's (+726), which every quad is drawn times, colour and alpha both.
  // [ParticleGameObject::updateParticleOpacity :297208-297211,
  //  updateMainParticleOpacity :297309-297327; updateQuadWithParticle
  //  :848041-848063]
  const level = emptyLevel([
    { id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString({ 0: 20, 4: 30 }), 57: "4" } },
    { id: CUSTOM_PARTICLE_ID, x: 400, y: 100, props: { 145: customString({ 0: 20, 4: 30, 53: 1 }), 57: "4" } },
  ]);
  for (const o of level.objects) if (o.props[57] !== undefined) o.groups = [4];
  const field = new ParticleField(level, particleAtlas());
  let group = 1;
  const frame = () => field.update(1 / 10, ON_SCREEN, { levelTime: 0, colors: null, animationsOf: () => 0, groupAlphaOf: (g) => (g === 4 ? group : 1) });
  frame();
  frame();
  group = 0.5;
  const { data, count } = frame();
  assert.ok(count >= 4, `both still emitting (${count})`);
  const bytes = new Uint8Array(data.buffer);
  const rgba = (i: number): number[] => [...bytes.slice(i * INSTANCE_BYTES + 40, i * INSTANCE_BYTES + 44)];
  // 255 × 0.5 is 127 in the game's byte.
  const near = (a: number[], b: number[]): boolean => a.every((v, k) => Math.abs(v - b[k]) <= 1);
  const all = [...Array(count).keys()];
  const normal = all.filter((i) => bytes[i * INSTANCE_BYTES + 46] === BLEND.NORMAL);
  const added = all.filter((i) => bytes[i * INSTANCE_BYTES + 46] === BLEND.ADD_PARTICLE);
  assert.ok(normal.length > 0 && added.length > 0);
  for (const i of normal) assert.ok(near(rgba(i), [255, 255, 255, 127]), `a normal one keeps its colour and halves its alpha: ${rgba(i)}`);
  for (const i of added) assert.ok(near(rgba(i), [127, 127, 127, 127]), `an additive one halves both: ${rgba(i)}`);
  group = 0;
  const gone = frame();
  assert.ok(gone.count > count, "at nothing it goes on emitting");
  const goneBytes = new Uint8Array(gone.data.buffer);
  for (let i = 0; i < gone.count; i++) assert.equal(goneBytes[i * INSTANCE_BYTES + 43], 0, "but draws nothing");
});

test("key 146: a Custom Particles object's opacity is the alpha its particles start at", () => {
  // +669 sends the main opacity to the start colour's alpha every frame, so
  // the definition's own start alpha counts for nothing.
  // [ParticleGameObject::updateMainParticleOpacity :297309-297327 (+496)]
  const startAlpha = (props: Record<number, string>): number => {
    const level = emptyLevel([{ id: CUSTOM_PARTICLE_ID, x: 300, y: 100, props: { 145: customString({ 27: 0.5, 39: 1 }), ...props } }]);
    const field = new ParticleField(level, particleAtlas());
    const { data, count } = field.update(1 / 100, ON_SCREEN, { levelTime: 0, colors: null, animationsOf: () => 0 });
    assert.equal(count, 1);
    return new Uint8Array(data.buffer)[43];
  };
  assert.equal(startAlpha({}), 127, "the definition's own half");
  assert.equal(startAlpha({ 146: "1" }), 255, "on its object's colours, its object's full opacity");
});

test("a frozen frame moves no particle and adds none", () => {
  // A paused level steps nothing. An editor "max" rate (-1) would otherwise
  // top its pool up at no time at all. [update :845480-845502]
  const e = new ParticleEmitter(custom({ 0: 5, 4: -1 }), 0, 0, 1);
  e.step(1 / 60, 100);
  e.step(1 / 60, 100);
  const before = baked(e);
  const count = e.count;
  assert.ok(count > 0);
  for (let i = 0; i < 10; i++) e.step(0, 100);
  assert.equal(e.count, count);
  assert.deepEqual(baked(e), before, "nothing moved");
  const empty = new ParticleEmitter(custom({ 0: 5, 4: -1 }), 0, 0, 1);
  empty.step(0, 100);
  assert.equal(empty.count, 0, "and an empty one stays empty");
});

test("particles add the way the game's quads do: additive ones by their own alpha, made-additive ones as sprites", () => {
  // An additive definition's quads carry their colour without their alpha
  // (+584 clear); a normal one's are premultiplied, and stay so when its
  // object makes it additive. [updateQuadWithParticle :848040-848063;
  //  updateBlendFunc :844213-844239]
  const blendOf = (e: ParticleEmitter): number => {
    const out = new Float32Array(16);
    const bytes = new Uint8Array(out.buffer);
    e.bake(out, bytes, 0, { u0: 0, v0: 0, du: 1, dv: 1, sheet: 0, rotated: 0 });
    return bytes[46];
  };
  const additive = new ParticleEmitter(custom({ 53: 1 }), 0, 0, 1);
  const normal = new ParticleEmitter(custom({ 53: 0 }), 0, 0, 1);
  for (const e of [additive, normal]) e.step(0.1, 10);
  assert.equal(blendOf(additive), BLEND.ADD_PARTICLE);
  assert.equal(blendOf(normal), BLEND.NORMAL);
  normal.objectBlend(true);
  assert.equal(blendOf(normal), BLEND.ADD_SPRITE);
});

test("an additive definition its object switches back to normal covers with its colour as it was, not dimmed by its alpha", () => {
  // setBlendAdditive(false) gives premultiplied art 1 / 771 and leaves +584
  // as setTexture left it: clear, for a system made additive. So the quads
  // keep their straight colour, times the fades and the opacity but not the
  // alpha, under ONE / ONE_MINUS_SRC_ALPHA. [CCParticleSystem::setBlendAdditive
  //  :844274-844296; updateBlendFunc :844213-844239; updateQuadWithParticle
  //  :848052-848060; ParticleGameObject::blendModeChanged :297285-297296]
  const bakedBlend = (e: ParticleEmitter): { blend: number; rgba: number[] } => {
    const out = new Float32Array(16);
    const bytes = new Uint8Array(out.buffer);
    e.bake(out, bytes, 0, { u0: 0, v0: 0, du: 1, dv: 1, sheet: 0, rotated: 0 });
    return { blend: bytes[46], rgba: [bytes[40], bytes[41], bytes[42], bytes[43]] };
  };
  // Half a second into a one-second fade-in: the fades give 0.5.
  const switched = new ParticleEmitter(custom({ 41: 1, 53: 1 }), 0, 0, 1);
  const normal = new ParticleEmitter(custom({ 41: 1, 53: 0 }), 0, 0, 1);
  for (const e of [switched, normal]) for (let i = 0; i < 5; i++) e.step(0.1, 10);
  switched.objectBlend(true);
  assert.equal(bakedBlend(switched).blend, BLEND.ADD_PARTICLE, "made additive, it stays an additive particle");
  switched.objectBlend(false);
  assert.equal(switched.additive, false);
  assert.deepEqual(bakedBlend(switched), { blend: BLEND.STRAIGHT, rgba: [127, 127, 127, 127] }, "colour times the fades, as the alpha is");
  assert.equal(blendAdds(BLEND.STRAIGHT), false, "it covers");
  // A normal definition is premultiplied: its colour is left whole here and
  // the shader takes it times its alpha.
  assert.deepEqual(bakedBlend(normal), { blend: BLEND.NORMAL, rgba: [255, 255, 255, 127] });
  // And the opacity its object gives the system is in the colour as well.
  switched.setSystemOpacity(0.5);
  const dim = bakedBlend(switched).rgba;
  assert.ok(dim.every((v) => Math.abs(v - 63) <= 1), `a quarter: ${dim}`);
});
