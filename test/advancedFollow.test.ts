import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level } from "../src/level/types";
import { NO_INPUT, type Sim } from "../src/physics/types";
import {
  AdvancedFollowSystem,
  closestDirectionMod,
  followSpeedVal,
  getSpecialKey,
  PositionHistory,
  type AdvFollowHost,
} from "../src/triggers/advancedFollow";
import { emptyLevel, type Placed, simOn, stepN } from "./levelKit";
import type { TriggerSpec } from "../src/triggers/spec";

function withGroups(extra: Placed[], groups: Record<number, number[]>): { level: Level; at: (i: number) => number } {
  const level = emptyLevel(extra);
  const first = level.objects.length - extra.length;
  for (const [i, g] of Object.entries(groups)) level.objects[first + Number(i)].groups = g;
  return { level, at: (i) => first + i };
}

const PI = 3.1416;

function centre(sim: Sim, index: number): [number, number] {
  const box = sim.hitboxOf(index);
  assert.ok(box && box.type === "rect");
  return [box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2];
}

function near(a: number, b: number, what: string, eps = 1e-4): void {
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
}

test("closestDirectionMod folds", () => {
  near(closestDirectionMod(4, PI), 4 - 2 * PI, "above pi");
  near(closestDirectionMod(-4, PI), -4 + 2 * PI, "below -pi");
  near(closestDirectionMod(0.5, PI), 0.5, "inside");
});

test("followSpeedVal angle 0 along +Y", () => {
  const host: AdvFollowHost = {
    grp: (id) => id,
    groupMembers: () => [],
    mainObject: () => -1,
    targetObject: () => -1,
    objectPosition: () => [0, 0],
    objectRotation: () => 0,
    objectId: () => 0,
    objectGroups: () => [],
    specOf: () => undefined,
    player1: () => [0, 0],
    player2: () => null,
    noteMoved: () => {},
    markDirty: () => {},
    setMotion: () => {},
  };
  const [vx, vy] = followSpeedVal(host, 0, 0, 0, 0, 5);
  near(vx, 0, "x");
  near(vy, 5, "y");
});

test("mode 0 closes on static target", () => {
  const { level, at } = withGroups(
    [
      { id: 3016, x: 0, y: 300, props: { 51: "2", 71: "3", 361: "10", 367: "0", 298: "999" } },
      { id: 1, x: 600, y: 600 },
      { id: 1, x: 700, y: 600 },
    ],
    { 1: [2], 2: [3] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 120);
  const [fx] = centre(sim, at(1));
  assert.ok(fx > 650, `follower should close on target x, got ${fx}`);
  assert.ok(fx < 705, `follower should not overshoot much, got ${fx}`);
});

test("mode 1 accelerates toward target", () => {
  const run = (mode: string): number => {
    const { level, at } = withGroups(
      [
        {
          id: 3016,
          x: 0,
          y: 300,
          props: {
            51: "2",
            71: "3",
            367: mode,
            334: mode === "1" ? "20" : "1",
            298: "999",
            558: mode === "1" ? "0.05" : "0.5",
            361: mode === "0" ? "200" : "10",
          },
        },
        { id: 1, x: 600, y: 600 },
        { id: 1, x: 700, y: 600 },
      ],
      { 1: [2], 2: [3] },
    );
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 60);
    return centre(sim, at(1))[0];
  };
  const m1 = run("1");
  const m0 = run("0");
  assert.ok(m1 > m0 + 5, `mode 1 (${m1}) should outrun mode 0 (${m0})`);
});

test("X-only ignores y gap", () => {
  const { level, at } = withGroups(
    [
      { id: 3016, x: 0, y: 300, props: { 51: "2", 71: "3", 306: "1", 361: "10", 367: "0", 298: "999" } },
      { id: 1, x: 600, y: 600 },
      { id: 1, x: 700, y: 750 },
    ],
    { 1: [2], 2: [3] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 90);
  const [, fy] = centre(sim, at(1));
  near(fy, 600, "y unchanged", 0.5);
  assert.ok(centre(sim, at(1))[0] > 620, "x should move");
});

test("key 138 tracks player 1", () => {
  const { level, at } = withGroups(
    [
      { id: 3016, x: 0, y: 300, props: { 51: "2", 138: "1", 361: "5", 367: "0", 298: "999" } },
      { id: 1, x: 400, y: 900 },
    ],
    { 1: [2] },
  );
  const sim = simOn(level);
  const x0 = centre(sim, at(1))[0];
  stepN(sim, { jump: false, left: false, right: true }, 24);
  const [fx] = centre(sim, at(1));
  const px = sim.state.x;
  assert.ok(Math.abs(fx - x0) > 0.5, "follower should move toward player");
  assert.ok(fx < px + 200, "follower should stay clear of the player");
  assert.ok(centre(sim, at(1))[1] > 850, "follower stays high");
});

test("Edit 3660: comparative 2x velocity edit travels further than no edit", () => {
  const base = [
    { id: 3016, x: 0, y: 300, props: { 51: "2", 71: "3", 367: "1", 334: "2", 298: "999", 300: "3", 563: "0" } },
    { id: 1, x: 600, y: 600 },
    { id: 1, x: 900, y: 600 },
  ] as Placed[];
  const run = (edit: boolean): number => {
    const extra = edit
      ? [...base, { id: 3660, x: 0, y: 301, props: { 51: "2", 566: "2", 568: "2" } }]
      : base;
    const { level, at } = withGroups(extra, { 1: [2], 2: [3] });
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 40);
    return centre(sim, at(1))[0];
  };
  const withEdit = run(true);
  const plain = run(false);
  assert.ok(withEdit > plain + 3, `edit (${withEdit}) should beat plain (${plain})`);
});

test("Retarget 3661 switches followed group", () => {
  const { level, at } = withGroups(
    [
      { id: 3016, x: 0, y: 300, props: { 51: "2", 71: "3", 361: "10", 367: "0", 298: "999" } },
      { id: 3661, x: 0, y: 302, props: { 51: "2", 71: "4" } },
      { id: 1, x: 600, y: 600 },
      { id: 1, x: 700, y: 600 },
      { id: 1, x: 600, y: 700 },
    ],
    { 2: [2], 3: [3], 4: [4] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 200);
  const [, fy] = centre(sim, at(2));
  assert.ok(fy > 650, `should follow retargeted group 4 y, got ${fy}`);
});

test("Stop 1616 ends advanced follow", () => {
  const { level, at } = withGroups(
    [
      { id: 3016, x: 0, y: 300, props: { 51: "2", 71: "3", 361: "5", 367: "0", 298: "999" } },
      { id: 1616, x: 400, y: 301, props: { 51: "1", 580: "0" } },
      { id: 1, x: 600, y: 600 },
      { id: 1, x: 900, y: 600 },
    ],
    { 0: [1], 1: [1], 2: [2], 3: [3] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 30);
  const mid = centre(sim, at(2))[0];
  stepN(sim, NO_INPUT, 120);
  const late = centre(sim, at(2))[0];
  assert.ok(late - mid < 15, `follow should stop after 1616 (${mid} -> ${late})`);
});

test("getSpecialKey packs group and the 280/281 flags", () => {
  assert.equal(getSpecialKey(5, false, false), 100000005);
  assert.equal(getSpecialKey(5, true, false), 110000005);
  assert.equal(getSpecialKey(5, false, true), 101000005);
  assert.equal(getSpecialKey(5, true, true), 111000005);
});

test("PositionHistory lerps a delayed sample and returns (0,0) before enough history", () => {
  const hist = new PositionHistory();
  hist.ensure(3, 50);
  let x = 0;
  const host: AdvFollowHost = {
    grp: (id) => id,
    groupMembers: () => [],
    mainObject: (g) => (g === 3 ? 0 : -1),
    targetObject: () => -1,
    objectPosition: () => [x, 100],
    objectRotation: () => 0,
    objectId: () => 1,
    objectGroups: () => [],
    specOf: () => undefined,
    player1: () => [0, 0],
    player2: () => null,
    noteMoved: () => {},
    markDirty: () => {},
    setMotion: () => {},
  };
  assert.deepEqual(hist.get(host, 3, 0.1), [0, 0], "no samples yet");
  for (let i = 0; i < 48; i++) {
    x = i * 10;
    hist.record(host);
  }
  const delayed = hist.get(host, 3, 0.1); // 24 frames back
  assert.ok(delayed[0] < x - 100, `delayed x ${delayed[0]} should lag live ${x}`);
  assert.ok(delayed[0] > 0, "should have a real sample");
  near(delayed[1], 100, "y");
});

test("a delayed follow lags a moving target", () => {
  const sys = new AdvancedFollowSystem();
  const positions = new Map<number, [number, number]>([
    [1, [0, 0]],
    [2, [0, 0]],
  ]);
  const spec = {
    id: 3016,
    index: 0,
    x: 0,
    y: 0,
    touch: false,
    spawnTriggered: false,
    multi: false,
    sharedPlayer: false,
    ordering: 0,
    channel: 0,
    controlId: 0,
    target: 1,
    target2: 2,
    activateGroup: false,
    duration: 0,
    easing: 0,
    easingRate: 0,
    groups: [] as number[],
    props: { 51: "1", 71: "2", 292: "0.1", 361: "1", 367: "0", 298: "999" },
  } satisfies TriggerSpec;
  const host: AdvFollowHost = {
    grp: (id) => id,
    groupMembers: (g) => (g === 1 ? [1] : g === 2 ? [2] : []),
    mainObject: (g) => (g === 2 ? 2 : -1),
    targetObject: () => -1,
    objectPosition: (i) => positions.get(i) ?? [0, 0],
    objectRotation: () => 0,
    objectId: (i) => (i === 0 ? 3016 : 1),
    objectGroups: () => [],
    specOf: (i) => (i === 0 ? spec : undefined),
    player1: () => [0, 0],
    player2: () => null,
    noteMoved: () => {},
    markDirty: () => {},
    setMotion: (i, dx, dy) => {
      const p = positions.get(i);
      if (p) {
        p[0] += dx;
        p[1] += dy;
      }
    },
  };
  const rand = { table: new Float32Array(2000), index: new Int32Array(32) };
  const rng = { seed: 1, next01: () => 0.5, next: () => 0, fork: () => rng };
  sys.trigger(spec, host);
  // Build history with the target still at 0, then jump it ahead.
  for (let i = 0; i < 30; i++) sys.step(1, i + 1, host, rand as never, rng as never);
  positions.get(2)![0] = 500;
  const before = positions.get(1)![0];
  for (let i = 0; i < 12; i++) sys.step(1, 31 + i, host, rand as never, rng as never);
  const soon = positions.get(1)![0];
  assert.ok(soon - before < 50, `delay should keep the follower near the old aim (${before} -> ${soon})`);
  for (let i = 0; i < 80; i++) sys.step(1, 43 + i, host, rand as never, rng as never);
  assert.ok(positions.get(1)![0] > 200, "then it catches the new target");
});

test("enter-effect group-copy passes move the copy members", () => {
  const sys = new AdvancedFollowSystem();
  const positions = new Map<number, [number, number]>([
    [1, [0, 0]],
    [2, [100, 0]],
    [10, [50, 0]],
  ]);
  const moved: number[] = [];
  const spec = {
    id: 3016,
    index: 0,
    x: 0,
    y: 0,
    touch: false,
    spawnTriggered: false,
    multi: false,
    sharedPlayer: false,
    ordering: 0,
    channel: 0,
    controlId: 0,
    target: 1,
    target2: 2,
    activateGroup: false,
    duration: 0,
    easing: 0,
    easingRate: 0,
    groups: [] as number[],
    props: { 51: "1", 71: "2", 361: "1", 367: "0", 298: "999", 280: "1" },
  } satisfies TriggerSpec;
  const host: AdvFollowHost = {
    grp: (id) => id,
    groupMembers: (g) => (g === 1 ? [1] : g === 2 ? [2] : []),
    mainObject: (g) => (g === 2 ? 2 : -1),
    targetObject: () => -1,
    objectPosition: (i) => positions.get(i) ?? [0, 0],
    objectRotation: () => 0,
    objectId: (i) => (i === 0 ? 3016 : 1),
    objectGroups: () => [],
    specOf: (i) => (i === 0 ? spec : undefined),
    player1: () => [0, 0],
    player2: () => null,
    enterCopySlot: (key) => (key === getSpecialKey(1, true, false) ? 3 : 0),
    copyGroupMembers: (slot, pass) => (slot === 3 && pass === 0 ? [10] : slot === 3 && pass === 1 ? [1] : []),
    noteMoved: () => {},
    markDirty: () => {},
    setMotion: (i, dx) => {
      const p = positions.get(i);
      if (p) {
        p[0] += dx;
        moved.push(i);
      }
    },
  };
  const rand = { table: new Float32Array(2000), index: new Int32Array(32) };
  const rng = { seed: 1, next01: () => 0.5, next: () => 0, fork: () => rng };
  sys.trigger(spec, host);
  for (let i = 0; i < 30; i++) sys.step(1, i + 1, host, rand as never, rng as never);
  assert.ok(moved.includes(10), "copy member should move");
  assert.ok(positions.get(10)![0] > 0, "copy closes on the target");
});
