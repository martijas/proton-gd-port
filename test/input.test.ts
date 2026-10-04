// The button, the rings a press takes, the release, the landing latch and the
// letter blocks, pinned to the 2.206 decompile rather than to measurements of
// this port. Each case names the lines it reads; the derivation is in
// data/ref/gd-discrepancies.md §1, §2, §13, §16 and §17.
//
// Constants at 1x: a jump sets 11.18, setYVelocity's three decimals of
// 11.1800318; a tick of cube or flying gravity is 0.958199024 × 0.225 =
// 0.2155948, which the rounding makes 0.216 while the velocity sits on
// thousandths [setYVelocity :141992-142007]; x per tick 1.29825, which the
// float position rounds as it adds it [PlayerObject::update :161084-161100].

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode, Level } from "../src/level/types";
import { F_CLAIM_TOUCH, ObjectSet } from "../src/physics/collision";
import { MacroPlayer } from "../src/debug/macro";
import { Player } from "../src/physics/player";
import { NO_INPUT, type PlayerInput, type Sim, type StartState } from "../src/physics/types";
import { loadObjectTable, makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, HOLD, makeHeader, settle, simOn, STANDING_Y, stepN, type Placed } from "./levelKit";

const EPS = 1e-9;
const YSTART = 11.18;
const CUBE_TICK_GRAVITY = 0.216;
const X_PER_TICK = 1.29825042525;
/** The float step, 1.2982504, added to a float x between 16 and 32 and to a float y (+90) between 128 and 256. */
const X_STEP_AT_X = 1.2982501983642578;
const X_STEP_AT_Y = 1.298248291015625;

/** A press and a release inside one step, the button ending up where it started. */
const TAP: PlayerInput = Object.freeze({ jump: false, tap: true, left: false, right: false });

/** Object ids. */
const ORB = { yellow: 36, pink: 141, blue: 84, black: 1330, toggle: 1594, dash: 1704, spider: 3004 } as const;
const LETTER = { S: 1829, H: 1859, J: 1813 } as const;
const YELLOW_PAD = 35;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

/** Player 1 as the sim holds it, for the fields PlayerState does not list. */
function p1(sim: Sim): Player {
  return sim.state as Player;
}

function p2(sim: Sim): Player {
  const p = sim.state2;
  assert.ok(p, "no player 2");
  return p as Player;
}

/** What happened on `tick`, in order: event types, with the object index for orbs. */
function eventsAt(sim: Sim, tick: number, player: 1 | 2 = 1): string[] {
  return sim.events.filter((e) => e.tick === tick && e.player === player).map((e) => (e.type === "orb" ? `orb#${e.object}` : e.type));
}

/** Ticks on which an orb fired. */
function orbTicks(sim: Sim): number[] {
  return sim.events.filter((e) => e.type === "orb").map((e) => e.tick);
}

/** A player in the air at (15, 150). In an emptyLevel(extra), extra[k] is object 100 + k. */
function inAir(level: Level, mode: GameMode = "cube", start: Partial<StartState> = {}): Sim {
  return simOn(level, { y: 150, ...start }, mode);
}

// --- §2: flying modes see the press in the same step ---------------------------------

test("ship: a press thrusts on the same step", () => {
  // pushButton sets +1909 and the same step's updateJump reads it; nothing
  // latches it. [gd-ida-decomp.cpp:160450 → 469914 → 161031 → 155495-155531]
  const sim = inAir(emptyLevel(), "ship");
  sim.step(HOLD);
  near(sim.state.yVel, 0.108, "yVel after the press step");
  near(sim.state.y, 150.02430725097656, "y");
  sim.step(HOLD);
  near(sim.state.yVel, 0.216, "yVel after the second held step");
});

test("ship: a one-tick press still counts", () => {
  const sim = inAir(emptyLevel(), "ship");
  sim.step(HOLD);
  sim.step(NO_INPUT);
  near(sim.state.yVel, 0.039, "yVel after tick 2");
});

test("UFO: a one-tick press hops on its own step", () => {
  // The hop reads +1910 and +1909 in the press step's updateJump. [155668-155700]
  const sim = inAir(emptyLevel(), "ufo");
  stepN(sim, NO_INPUT, 10);
  near(sim.state.yVel, -0.86, "falling before the press");
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 11), ["jump"], "the hop is on the press step");
  near(sim.state.yVel, 6.871, "yVel");
  near(sim.state.y, 150.4817352294922, "y");
  sim.step(NO_INPUT);
  near(sim.state.yVel, 6.742, "the step after");
});

test("swing: the click flips on the press step, and that step falls the new way", () => {
  // updateJump reads flipMod after the click's flip. [155606-155627]
  const sim = inAir(emptyLevel(), "swing", { y: 200 });
  stepN(sim, NO_INPUT, 40);
  near(sim.state.yVel, -3.44, "falling before the click");
  sim.step(HOLD);
  assert.equal(sim.state.flipped, true, "flipped on the press step");
  // −3.44 × 0.8 = −2.752 by the click (the flip's halving is overwritten),
  // then one tick of swing gravity the new way: +0.086. [155610-155615]
  near(sim.state.yVel, -2.666, "yVel");
});

test("wave: the first held step already climbs", () => {
  const sim = inAir(emptyLevel(), "wave");
  stepN(sim, NO_INPUT, 8);
  const { x, y } = sim.state;
  sim.step(HOLD);
  near(sim.state.x - x, X_STEP_AT_X, "dx");
  near(sim.state.y - y, X_STEP_AT_Y, "dy");
  assert.equal(p1(sim).stepY, Math.fround(X_PER_TICK), "the same float step both ways");
});

test("every flying mode answers the press on its own step, whatever the size, gravity, direction or frame", () => {
  // Nothing between pushButton and updateJump depends on any of these, so a
  // press step always pulls away from the same step without it: up against
  // gravity for the ship, UFO and wave, and a flip for the swing. A dual's
  // player 2 answers player 1's button in the same step too.
  // [160450 → 469914 → 161031 → 155495-155706]
  const variants: Array<{ label: string; start: Partial<StartState>; level?: Level; rotated?: boolean }> = [
    { label: "plain", start: {} },
    { label: "mini", start: { mini: true } },
    { label: "flipped", start: { flipped: true } },
    { label: "reversed", start: { x: 300, reversed: true } },
    { label: "platformer", start: {}, level: emptyLevel([], makeHeader({ platformer: true })) },
    // Travelling along y, gravity along x; kept inside the corridor's world band.
    { label: "rotated", start: { x: 300, y: 100 }, rotated: true },
    { label: "dual", start: { dual: true } },
  ];
  for (const mode of ["ship", "ufo", "wave", "swing"] as const) {
    for (const v of variants) {
      const run = (press: boolean): Sim => {
        const sim = inAir(v.level ?? emptyLevel(), mode, v.start);
        if (v.rotated) p1(sim).rotated = true;
        stepN(sim, NO_INPUT, 10);
        sim.step(press ? HOLD : NO_INPUT);
        return sim;
      };
      const pressed = run(true);
      const idle = run(false);
      const players: Array<[Player, Player]> = [[p1(pressed), p1(idle)]];
      if (v.start.dual) players.push([p2(pressed), p2(idle)]);
      for (const [k, [a, b]] of players.entries()) {
        const what = `${mode}, ${v.label}, player ${k + 1}`;
        if (mode === "swing") {
          assert.notEqual(a.flipped, b.flipped, `${what}: the click flips on the press step`);
        } else {
          // yVel is along the player's own gravity axis in every frame.
          const up = (a.yVel - b.yVel) * (a.flipped ? -1 : 1);
          assert.ok(up > 0.1, `${what}: the press step already pulls up (${up})`);
        }
      }
    }
  }
});

// --- §1: rings at the press ------------------------------------------------------------

test("a press inside an orb fires it before the move", () => {
  // The first pass lists the orb; the press takes it, then the step's own
  // updateJump pulls on the launch. [pushButton :160455-160524]
  const sim = inAir(emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]));
  sim.step(NO_INPUT);
  near(sim.state.y, 149.95140075683594, "y after the first step");
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 2), ["orb#100"]);
  near(sim.state.yVel, YSTART - CUBE_TICK_GRAVITY, "yVel");
  near(sim.state.y, 152.41830444335938, "y");
});

test("a press takes an orb before the move whatever the player's size, gravity, direction or frame", () => {
  const cases: Array<{ label: string; level: Level; start: Partial<StartState>; rotated?: boolean; yVel: number; at: [number, number] }> = [
    {
      label: "mini",
      level: emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]),
      start: { mini: true },
      yVel: YSTART * 0.8 - CUBE_TICK_GRAVITY,
      at: [17.596501, 151.9152069091797],
    },
    {
      label: "flipped",
      level: emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]),
      start: { flipped: true },
      yVel: -(YSTART - CUBE_TICK_GRAVITY),
      at: [17.596501, 147.58169555664062],
    },
    {
      label: "reversed",
      level: emptyLevel([{ id: ORB.yellow, x: 290, y: 150 }]),
      start: { x: 300, reversed: true },
      yVel: YSTART - CUBE_TICK_GRAVITY,
      at: [297.40350341796875, 152.41830444335938],
    },
    {
      label: "platformer",
      level: emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }], makeHeader({ platformer: true })),
      start: {},
      yVel: YSTART - CUBE_TICK_GRAVITY,
      at: [15, 152.41830444335938],
    },
    // Gameplay turned a quarter, as a Rotate Gameplay trigger leaves it: the
    // player travels along y and the launch lands on x. The press runs in the
    // world frame; the pass that listed the orb ran in the mirror.
    {
      label: "rotated",
      level: buildLevel([{ id: ORB.yellow, x: 300, y: 305 }]),
      start: { x: 300, y: 300 },
      rotated: true,
      yVel: YSTART - CUBE_TICK_GRAVITY,
      at: [302.41827392578125, 302.59649658203125],
    },
  ];
  for (const c of cases) {
    const sim = inAir(c.level, "cube", c.start);
    if (c.rotated) p1(sim).rotated = true;
    sim.step(NO_INPUT);
    sim.step(HOLD);
    assert.deepEqual(eventsAt(sim, 2), [`orb#${c.level.objects.length - 1}`], `${c.label}: the orb at the press`);
    near(sim.state.yVel, c.yVel, `${c.label}: yVel`);
    near(sim.state.x, c.at[0], `${c.label}: x`, 1e-6);
    near(sim.state.y, c.at[1], `${c.label}: y`, 1e-6);
  }
});

test("a grounded press inside an orb takes the orb instead of jumping", () => {
  // The immediate jump is only for an empty ring list. [160455, 160528-160531]
  const sim = simOn(emptyLevel([{ id: ORB.pink, x: 120, y: 60 }]));
  settle(sim);
  while (sim.state.x < 88) sim.step(NO_INPUT);
  assert.equal(sim.tick, 57);
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 58), ["orb#100"], "the orb, no jump");
  near(sim.state.yVel, 7.834, "yVel");
  near(sim.state.y, 46.76264953613281, "y");
});

test("a grounded press inside a toggle orb fires it and still jumps, from updateJump", () => {
  // The toggle orb leaves the ground latch, so the step's updateJump jumps
  // with the button still down, and that jump tick gets no gravity. [155762]
  const sim = simOn(emptyLevel([{ id: ORB.toggle, x: 20, y: 60 }]));
  settle(sim);
  assert.equal(sim.tick, 12);
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 13), ["orb#100", "jump"]);
  near(sim.state.yVel, YSTART, "yVel");
  near(sim.state.y, 47.5155029296875, "y");
});

test("a grounded press inside a black orb: the cube takes it and jumps, the robot takes it and stays", () => {
  // The black orb spends the press and leaves the ground flags; the cube's
  // ground jump needs only the button, the robot's needs the press too. [160352-160383, 155455-155462]
  const cube = simOn(emptyLevel([{ id: ORB.black, x: 20, y: 60 }]));
  settle(cube);
  cube.step(HOLD);
  assert.deepEqual(eventsAt(cube, 13), ["orb#100", "jump"], "cube");
  near(cube.state.yVel, YSTART, "cube yVel");

  const robot = simOn(emptyLevel([{ id: ORB.black, x: 20, y: 60 }]), {}, "robot");
  settle(robot);
  const tick = robot.tick + 1;
  robot.step(HOLD);
  assert.deepEqual(eventsAt(robot, tick), ["orb#100"], "robot");
  near(robot.state.yVel, 0, "robot yVel");
  near(robot.state.y, 45, "robot y");
  assert.equal(robot.state.onGround, true, "robot on the ground");
});

test("a ball pressing on the ground inside a blue orb takes the orb, not its own click", () => {
  const sim = simOn(emptyLevel([{ id: ORB.blue, x: 20, y: 60 }]), {}, "ball");
  settle(sim);
  const tick = sim.tick + 1;
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, tick), ["flip", "orb#100"]);
  assert.equal(sim.state.flipped, true);
  near(sim.state.yVel, 3.26, "yVel");
  assert.equal(sim.state.holding, false, "the ball's orb lets go of the button");
});

test("the press window for a ground mode: first overlap after the move, then at the press until two steps after the last", () => {
  // Passes 44 to 60 overlap the orb. A press on 44 fires in that pass; from
  // 45 on the press fires it itself, and the list keeps the orb for two
  // passes after the last touch. [resetTouchedRings :153480-153500, :469851]
  const level = emptyLevel([{ id: ORB.yellow, x: 60, y: 120 }]);
  const pressAt = (t: number): Sim => {
    const sim = simOn(level, { y: 200 });
    for (let k = 1; k <= t + 2; k++) sim.step(k === t ? HOLD : NO_INPUT);
    return sim;
  };
  assert.deepEqual(orbTicks(pressAt(43)), [], "43: before the first overlap");
  for (const t of [44, 45, 60, 61, 62]) {
    const sim = simOn(level, { y: 200 });
    stepN(sim, NO_INPUT, t - 1);
    sim.step(HOLD);
    assert.deepEqual(orbTicks(sim), [t], `${t}: the orb fires on the press step`);
    near(sim.state.yVel, t === 44 ? YSTART : YSTART - CUBE_TICK_GRAVITY, `${t}: yVel`);
  }
  assert.deepEqual(orbTicks(pressAt(63)), [], "63: gone from the list");
});

test("ship: an orb answers only a press, from one step after the first overlap to two after the last", () => {
  // playerTouchedRing never fires a ring for a flying player. [463289-463290]
  const level = emptyLevel([{ id: ORB.yellow, x: 60, y: 150 }]);
  for (const t of [10, 11, 60, 61, 62, 63]) {
    const sim = inAir(level, "ship");
    stepN(sim, NO_INPUT, t - 1);
    sim.step(HOLD);
    sim.step(NO_INPUT);
    const fires = t !== 10 && t !== 63;
    assert.deepEqual(orbTicks(sim), fires ? [t] : [], `press on ${t}`);
    if (fires) {
      const again = inAir(level, "ship");
      stepN(again, NO_INPUT, t - 1);
      again.step(HOLD);
      // The launch is 11.18; the same step's updateJump caps it at 8.
      near(again.state.yVel, 8, `press on ${t}: yVel`);
    }
  }
  const held = inAir(level, "ship");
  stepN(held, HOLD, 60);
  assert.deepEqual(orbTicks(held), [], "a button held through the orb never fires it");
});

test("UFO: a press inside an orb takes it instead of hopping", () => {
  // The ring spends +1910 at the press, so updateJump's hop does not happen.
  const sim = inAir(emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]), "ufo");
  sim.step(NO_INPUT);
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 2), ["orb#100"]);
  near(sim.state.yVel, 8, "yVel, capped");
  assert.equal(p1(sim).isAccelerating, false);
  sim.step(HOLD);
  near(sim.state.yVel, 7.871, "the next held step");
});

test("UFO: a press inside a blue orb flips it", () => {
  const sim = inAir(emptyLevel([{ id: ORB.blue, x: 20, y: 150 }]), "ufo");
  sim.step(NO_INPUT);
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 2), ["flip", "orb#100"]);
  assert.equal(sim.state.flipped, true);
  near(sim.state.yVel, 4.558, "yVel");
});

test("swing and wave take an orb at the press", () => {
  const level = emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]);
  const swing = inAir(level, "swing");
  swing.step(NO_INPUT);
  swing.step(HOLD);
  assert.deepEqual(eventsAt(swing, 2), ["orb#100"], "swing");
  assert.equal(swing.state.flipped, false, "the ring spent the press, so no click");
  near(swing.state.yVel, 6.622, "swing yVel");

  const wave = inAir(level, "wave");
  wave.step(NO_INPUT);
  const y = wave.state.y;
  wave.step(HOLD);
  assert.deepEqual(eventsAt(wave, 2), ["orb#100"], "wave");
  near(wave.state.y - y, X_STEP_AT_Y, "wave dy");
});

test("a press fires custom rings first and one ring per family", () => {
  // [pushButton :160484-160524; ringJump's family flags :159909-159913, :159928-159938]
  const sim = inAir(
    emptyLevel([
      { id: ORB.yellow, x: 20, y: 150 },
      { id: ORB.yellow, x: 25, y: 150 },
      { id: ORB.toggle, x: 20, y: 150 },
    ]),
  );
  sim.step(NO_INPUT);
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 2), ["orb#102", "orb#100"]);
  near(sim.state.yVel, YSTART - CUBE_TICK_GRAVITY, "yVel");
});

test("a claim-touch ring answers only a press, alone, and lets go of the button", () => {
  // Key 445 is read for custom rings (type 36) only.
  // [playerTouchedRing :463289-463291; pushButton :160478-160482; key 445 → +1635 at :302969-302983]
  const level = emptyLevel([
    { id: ORB.yellow, x: 20, y: 150 },
    { id: ORB.toggle, x: 20, y: 150, props: { 445: "1" } },
  ]);
  const set = new ObjectSet(level, loadObjectTable());
  assert.equal(set.flags[100] & F_CLAIM_TOUCH, 0, "a plain orb");
  assert.notEqual(set.flags[101] & F_CLAIM_TOUCH, 0, "key 445");
  const off = new ObjectSet(emptyLevel([{ id: ORB.toggle, x: 20, y: 150, props: { 445: "0" } }]), loadObjectTable());
  assert.equal(off.flags[100] & F_CLAIM_TOUCH, 0, "key 445 set to 0");
  for (const id of [ORB.yellow, ORB.pink, ORB.dash]) {
    const other = new ObjectSet(emptyLevel([{ id, x: 20, y: 150, props: { 445: "1" } }]), loadObjectTable());
    assert.equal(other.flags[100] & F_CLAIM_TOUCH, 0, `key 445 on orb ${id} is ignored`);
  }
  const yellow = inAir(emptyLevel([{ id: ORB.yellow, x: 20, y: 150, props: { 445: "1" } }]));
  stepN(yellow, HOLD, 2);
  assert.deepEqual(eventsAt(yellow, 1), ["orb#100"], "a yellow orb with key 445 still fires on contact");

  const pressed = inAir(level);
  pressed.step(NO_INPUT);
  pressed.step(HOLD);
  assert.deepEqual(orbTicks(pressed), [2], "a: one ring");
  assert.deepEqual(eventsAt(pressed, 2), ["orb#101"], "a: the claim ring, alone");
  assert.equal(pressed.state.holding, false, "a: the button is let go");
  near(pressed.state.yVel, -2 * CUBE_TICK_GRAVITY, "a: yVel");

  const held = inAir(level);
  stepN(held, HOLD, 3);
  assert.deepEqual(eventsAt(held, 1), ["orb#100"], "b: the pass fires the plain ring");
  assert.deepEqual(orbTicks(held), [1], "b: never the claim ring");

  const grounded = simOn(emptyLevel([{ id: ORB.toggle, x: 20, y: 60, props: { 445: "1" } }]));
  settle(grounded);
  stepN(grounded, HOLD, 2);
  assert.deepEqual(eventsAt(grounded, 13), ["orb#100"], "c: the ring, no jump");
  assert.deepEqual(eventsAt(grounded, 14), [], "c: and no jump on the next step");
  near(grounded.state.yVel, 0, "c: yVel");
  assert.equal(grounded.state.onGround, true, "c: still on the ground");
});

test("a multi-activate orb answers every fresh press without being left", () => {
  // The used set (+1700) is emptied by each press. [160453, 159898-159920]
  const orbAt = (props: Record<number, string>): Sim => {
    const sim = simOn(emptyLevel([{ id: ORB.yellow, x: 20, y: 300, scaleX: 8, scaleY: 8, props }]), { y: 300 });
    sim.step(NO_INPUT);
    sim.step(HOLD);
    stepN(sim, NO_INPUT, 3);
    sim.step(HOLD);
    return sim;
  };
  const multi = orbAt({ 99: "1" });
  assert.deepEqual(orbTicks(multi), [2, 6], "key 99");
  near(multi.state.yVel, YSTART - CUBE_TICK_GRAVITY, "yVel after the second");
  assert.deepEqual(orbTicks(orbAt({})), [2], "without key 99");
});

test("dual: player 2 takes its own orb at the press while player 1 jumps", () => {
  // Both players' buttons are handled before either moves; each has its own list.
  // [GJBaseGameLayer::update :469850-469853; handleButton :463936, 463961]
  const sim = makeSim(emptyLevel([{ id: ORB.pink, x: 150, y: 250 }]), undefined, { start: { x: 15, y: 45, dual: true } });
  stepN(sim, NO_INPUT, 86);
  assert.deepEqual(p2(sim).touchingRings, [100], "player 2 is in the orb");
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 87, 1), ["jump"], "player 1");
  assert.deepEqual(eventsAt(sim, 87, 2), ["orb#100"], "player 2");
  near(sim.state.yVel, YSTART - CUBE_TICK_GRAVITY, "player 1 yVel");
  near(p2(sim).yVel, -7.834, "player 2 yVel");
  assert.equal(p2(sim).flipped, true, "player 2 still flipped");
});

test("a press sees the level where the last step left it, before this step's moves", () => {
  // processCommands runs before the move actions, so a spider orb taken at
  // the press searches a moving block where it was, then the block moves on.
  // [GJBaseGameLayer::update :469850 before :469890-469893]
  const level = emptyLevel([
    { id: ORB.spider, x: 20, y: 150, scaleX: 4, scaleY: 4 },
    { id: 1, x: 15, y: 250, scaleX: 4 },
    // Group 1 rises 1 unit a step from step 3 on.
    { id: 901, x: 0, y: 300, props: { 51: "1", 28: "0", 29: "240", 10: "1" } },
  ]);
  const block = level.objects.length - 2;
  level.objects[block].groups = [1];
  let yAtJump = NaN;
  const sim = makeSim(level, undefined, {
    start: { x: 15, y: 150, mode: "spider" },
    onEvent: (e) => {
      if (e.type === "jump") yAtJump = sim.state.y;
    },
  });
  const underside = (): number => {
    const box = sim.hitboxOf(block);
    assert.ok(box && box.type === "rect");
    return box.rect.y;
  };
  stepN(sim, NO_INPUT, 3);
  const before = underside();
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 4), ["flip", "jump", "orb#100"]);
  near(underside() - before, 1, "the block moved on this step");
  near(yAtJump, before - p1(sim).hitboxSize() / 2, "the jump found it where it was");
});

/** A block in group 1, out of the way, and a Move trigger at x 0 that locks group 1 to player 1 on both axes. */
function playerLocked(extra: Placed[] = []): { level: Level; block: number } {
  const level = emptyLevel([
    ...extra,
    { id: 1, x: 600, y: 600 },
    { id: 901, x: 0, y: 300, props: { 51: "1", 58: "1", 59: "1", 10: "60" } },
  ]);
  const block = level.objects.length - 2;
  level.objects[block].groups = [1];
  return { level, block };
}

/** The block's bottom-left corner. */
function corner(sim: Sim, block: number): [number, number] {
  const box = sim.hitboxOf(block);
  assert.ok(box && box.type === "rect");
  return [box.rect.x, box.rect.y];
}

test("a player-locked move follows the player's last step, measured after the press", () => {
  // The delta is the player's position after processCommands less where its
  // last update began (+1052), so the group trails the player by one step:
  // the trigger, at x 0 behind the player, fires at the reset, its command
  // sits out step 1, and step 2 moves the group by step 1's travel, measured
  // from where resetLevel starts the last position: on the player.
  // [GJBaseGameLayer::update :469859-469877; PlayerObject::update :161026;
  //  PlayLayer::resetLevel :105934-105936, its pass-by check :105954-105963]
  const { level, block } = playerLocked();
  const sim = simOn(level);
  const px = [sim.state.x];
  const py = [sim.state.y];
  const [bx0, by0] = corner(sim, block);
  const bx = [bx0];
  const by = [by0];
  const run = (from: number, to: number): void => {
    for (let k = from; k <= to; k++) {
      sim.step(k >= 20 ? HOLD : NO_INPUT);
      px[k] = sim.state.x;
      py[k] = sim.state.y;
      [bx[k], by[k]] = corner(sim, block);
    }
  };
  run(1, 40);
  const snap = sim.snapshot();
  run(41, 90);
  assert.equal(bx[1], bx[0], "nothing moves before the command's second step");
  assert.equal(by[1], by[0], "nor in y");
  for (let k = 2; k <= 90; k++) {
    near(bx[k] - bx[k - 1], px[k - 1] - px[k - 2], `x on step ${k}`);
    near(by[k] - by[k - 1], py[k - 1] - py[k - 2], `y on step ${k}`);
  }
  assert.ok(Math.max(...py) > STANDING_Y + 30, "the player did jump");
  // The snapshot carries the last position and the y step, so a rewind moves
  // the group the same way again.
  const after = corner(sim, block);
  sim.restore(snap);
  run(41, 90);
  assert.deepEqual(corner(sim, block), after, "the same group position after a rewind");
});

test("a spider's jump at the press is too far a y delta for a player-locked move", () => {
  // The press puts the spider on the ceiling before the move commands look,
  // and a y delta more than 4 units off the last update's own y step is
  // dropped, so the group never takes the jump. x still follows.
  // [GJBaseGameLayer::update :469865; PlayerObject::update :161081]
  const { level, block } = playerLocked(floor(0, 3000, 215));
  const sim = simOn(level, {}, "spider");
  settle(sim);
  const yFloor = sim.state.y;
  const [x0, y0] = corner(sim, block);
  sim.step(HOLD);
  // The jump leaves the spider off the ground; the same step's pass lands it.
  // [spiderTestJumpInternal :155210-155215]
  assert.deepEqual(eventsAt(sim, sim.tick), ["flip", "jump", "land"]);
  const [x1, y1] = corner(sim, block);
  near(x1 - x0, X_PER_TICK, "x takes the last step", 1e-6);
  assert.equal(y1, y0, "the jump is dropped");
  stepN(sim, NO_INPUT, 20);
  assert.ok(sim.state.y - yFloor > 100, `the spider is up on the ceiling (y ${sim.state.y})`);
  near(corner(sim, block)[1], y0, "and the group never went with it", 1e-6);
});

test("snapshot and restore carry the ring list", () => {
  const sim = inAir(emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]));
  sim.step(NO_INPUT);
  const snap = sim.snapshot();
  stepN(sim, NO_INPUT, 30);
  sim.restore(snap);
  sim.step(HOLD);
  assert.deepEqual(eventsAt(sim, 2), ["orb#100"]);
  near(sim.state.yVel, YSTART - CUBE_TICK_GRAVITY, "yVel");
});

test("snapshot and restore carry the rings the last pass touched", () => {
  // Pass 60 is the last to touch the orb; step 61's resetTouchedRings keeps it
  // only because that pass listed it, so a press on 62 still takes it.
  const sim = simOn(emptyLevel([{ id: ORB.yellow, x: 60, y: 120 }]), { y: 200 });
  stepN(sim, NO_INPUT, 60);
  const snap = sim.snapshot();
  stepN(sim, NO_INPUT, 30);
  sim.restore(snap);
  sim.step(NO_INPUT);
  sim.step(HOLD);
  assert.deepEqual(orbTicks(sim), [62]);
});

test("snapshot and restore carry the rings this press has used", () => {
  // A multi-activate toggle orb that leaves the press (kA40) fires once per
  // press, however long it is held inside. [+1700: pushButton :160453, ringJump :159898-159920]
  const sim = inAir(
    emptyLevel([{ id: ORB.toggle, x: 20, y: 300, scaleX: 8, scaleY: 8, props: { 99: "1" } }], makeHeader({ enable22Changes: true })),
    "cube",
    { y: 300 },
  );
  sim.step(NO_INPUT);
  sim.step(HOLD);
  assert.deepEqual(orbTicks(sim), [2], "the press fires it");
  const snap = sim.snapshot();
  stepN(sim, HOLD, 3);
  assert.deepEqual(orbTicks(sim), [2], "held on, it does not fire again");
  // Let go, fall out of the orb and press again, which empties the set.
  stepN(sim, NO_INPUT, 100);
  sim.step(HOLD);
  assert.deepEqual(p1(sim).usedRings, [], "a new press starts a new set");
  sim.restore(snap);
  stepN(sim, HOLD, 3);
  assert.deepEqual(orbTicks(sim), [2], "held on after the restore, it still does not fire again");
});

test("the state hash folds in the rings, the letter blocks, the pad-or-ring flag and the grown-back snap", () => {
  const sim = simOn(emptyLevel());
  const p = p1(sim);
  const h0 = sim.stateHash();
  const changes = (what: string, set: () => void, unset: () => void): void => {
    set();
    assert.notEqual(sim.stateHash(), h0, what);
    unset();
    assert.equal(sim.stateHash(), h0, `${what}: undone, the same hash`);
  };
  changes("a ring on the list", () => p.touchingRings.push(100), () => p.touchingRings.pop());
  changes("a ring the last pass touched", () => p.ringsThisPass.push(100), () => p.ringsThisPass.pop());
  changes("a ring this press used", () => p.usedRings.push(100), () => p.usedRings.pop());
  changes("a letter block wearing off", () => (p.stateHitHead = 1), () => (p.stateHitHead = 0));
  changes("the pad-or-ring flag", () => (p.padRingRelated = true), () => (p.padRingRelated = false));
  changes("the grown-back snap", () => (p.scaleSnapPasses = 2), () => (p.scaleSnapPasses = 0));
});

test("a practice respawn empties the ring list, ends the letter blocks, and arms the grown-back snap only in a platformer", () => {
  // The respawn resets the player before the checkpoint loads, and the
  // checkpoint keeps neither. [resetObject :153620-153621 → resetStateVariables
  // :153520-153533, resetTouchedRings(true) :153489-153491; saveToCheckpoint :161518-161589]
  const inOrb = simOn(emptyLevel([{ id: ORB.pink, x: 120, y: 60 }]));
  settle(inOrb);
  while (inOrb.state.x < 88) inOrb.step(NO_INPUT);
  const checkpoint = inOrb.snapshot();
  inOrb.step(HOLD);
  assert.deepEqual(eventsAt(inOrb, 58), ["orb#100"], "restored exactly, the press takes the orb");
  inOrb.respawnFrom(checkpoint);
  assert.deepEqual(p1(inOrb).touchingRings, [], "respawned, the list is empty");
  inOrb.step(HOLD);
  assert.deepEqual(eventsAt(inOrb, 58), ["jump"], "so the press jumps from the ground");
  near(inOrb.state.yVel, YSTART - CUBE_TICK_GRAVITY, "yVel");

  const onH = simOn(emptyLevel([{ id: LETTER.H, x: 75, y: 45 }]));
  stepN(onH, NO_INPUT, 30);
  const atH = onH.snapshot();
  stepN(onH, NO_INPUT, 60);
  onH.restore(atH);
  assert.equal(p1(onH).stateHitHead, 2, "restored exactly, the H block still holds");
  onH.respawnFrom(atH);
  assert.equal(p1(onH).stateHitHead, 0, "respawned, it has ended");

  // The grown-back snap (+2212) is zeroed beside the letter blocks.
  // [resetStateVariables :153533]
  const grown = simOn(emptyLevel());
  p1(grown).scaleSnapPasses = 2;
  const atGrown = grown.snapshot();
  grown.restore(atGrown);
  assert.equal(p1(grown).scaleSnapPasses, 2, "restored exactly, the snap still holds");
  grown.respawnFrom(atGrown);
  assert.equal(p1(grown).scaleSnapPasses, 0, "respawned, it has ended");

  // In a platformer resetObject then grows the player back from 0.6, which
  // arms it again, and taking the checkpoint's size, mini or not, never
  // touches it. Player 2 is reset the same way.
  // [resetObject :153659-153660 → togglePlayerScale :150416-150418;
  //  resetPlayer :425070-425075; loadFromCheckpoint :161647]
  for (const mini of [false, true]) {
    const plat = simOn(emptyLevel([], makeHeader({ platformer: true, startDual: true })), { mini });
    stepN(plat, NO_INPUT, 10);
    assert.deepEqual([p1(plat).scaleSnapPasses, p2(plat).scaleSnapPasses], [0, 0], `mini ${mini}: worn off`);
    const atPlat = plat.snapshot();
    plat.restore(atPlat);
    assert.equal(p1(plat).scaleSnapPasses, 0, `mini ${mini}: restored exactly, still off`);
    plat.respawnFrom(atPlat);
    assert.deepEqual([p1(plat).scaleSnapPasses, p2(plat).scaleSnapPasses], [2, 2], `mini ${mini}: respawned, armed`);
    assert.equal(plat.state.mini, mini, `mini ${mini}: the checkpoint's size`);
  }
});

// --- §16: releasing ends a dash before the move --------------------------------------

test("releasing ends a dash before the move", () => {
  // releaseButton runs in processCommands; stopDashing writes no velocity, so
  // the release step falls from the dash's 0. [159516-159524, 149796-149799]
  for (const [r, yAfterPress] of [
    [0, 149.95140075683594],
    [-45, 151.24964904785156],
  ] as const) {
    const sim = inAir(emptyLevel([{ id: ORB.dash, x: 20, y: 150, rotation: r }]));
    sim.step(NO_INPUT);
    sim.step(HOLD);
    assert.deepEqual(eventsAt(sim, 2), ["dashStart", "orb#100"], `r ${r}: the dash starts at the press`);
    near(sim.state.y, yAfterPress, `r ${r}: y after the press step`);
    stepN(sim, HOLD, 8);
    const { x, y } = sim.state;
    sim.step(NO_INPUT);
    assert.deepEqual(eventsAt(sim, 11), ["dashEnd"], `r ${r}: the release ends it`);
    near(sim.state.yVel, -CUBE_TICK_GRAVITY, `r ${r}: yVel`);
    near(sim.state.y - y, -0.0485992431640625, `r ${r}: dy`);
    near(sim.state.x - x, X_STEP_AT_X, `r ${r}: dx`);
  }
});

test("an S block ends the dash and lets go of the button", () => {
  // [touchedObject :159708-159713]
  const sim = inAir(
    emptyLevel([
      { id: ORB.dash, x: 20, y: 150 },
      { id: LETTER.S, x: 60, y: 150 },
    ]),
  );
  sim.step(NO_INPUT);
  for (let i = 0; i < 20 && !sim.events.some((e) => e.type === "dashEnd"); i++) sim.step(HOLD);
  assert.deepEqual(
    sim.events.filter((e) => e.type === "dashEnd").map((e) => e.tick),
    [12],
  );
  assert.equal(sim.state.holding, false);
  assert.equal(sim.state.dashing, false);
});

// --- §13: the jump latch ---------------------------------------------------------

test("hitGround: every contact grounds, only one at ≤ 5 arms the latch", () => {
  // [hitGround :150025, 150164-150170]
  const cases: Array<{ label: string; yVel: number; flipped: boolean; ceiling: boolean; latched?: boolean; armed: boolean }> = [
    { label: "a: 6 into a ceiling", yVel: 6, flipped: false, ceiling: true, armed: false },
    { label: "b: 5 into a ceiling", yVel: 5, flipped: false, ceiling: true, armed: true },
    { label: "c: flipped, −6", yVel: -6, flipped: true, ceiling: true, armed: false },
    { label: "d: flipped, −5", yVel: -5, flipped: true, ceiling: true, armed: true },
    { label: "e: a landing at −20", yVel: -20, flipped: false, ceiling: false, armed: true },
    { label: "f: already latched, 6", yVel: 6, flipped: false, ceiling: true, latched: true, armed: false },
  ];
  for (const c of cases) {
    const p = new Player({ emit() {}, spiderJump() {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true }, 1);
    p.tick = 100;
    p.clock = 100;
    p.lastLandTick = -5;
    p.flipped = c.flipped;
    p.yVel = c.yVel;
    p.onGround = c.latched ?? false;
    p.hitGround(-1, c.ceiling);
    assert.equal(p.onGround2, true, `${c.label}: on the ground`);
    near(p.yVel, 0, `${c.label}: yVel`);
    assert.equal(p.onGround, c.armed || (c.latched ?? false), `${c.label}: the latch`);
    assert.equal(p.lastLandTick, c.armed ? 100 : -5, `${c.label}: the landing time`);
  }
});

test("hitGroundNoJump: the contact stops the player and leaves both ground flags and the landing time", () => {
  // [hitGroundNoJump :150215-150229]
  for (const before of [false, true]) {
    const p = new Player({ emit() {}, spiderJump() {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true }, 1);
    p.tick = 100;
    p.clock = 100;
    p.lastLandTick = -5;
    p.yVel = 3;
    p.onGround = before;
    p.onGround2 = before;
    p.hitGroundNoJump(-1, true);
    near(p.yVel, 0, `${before}: yVel`);
    assert.equal(p.onGround, before, `${before}: the latch`);
    assert.equal(p.onGround2, before, `${before}: on the ground`);
    assert.equal(p.lastLandTick, -5, `${before}: the landing time`);
  }
});

test("a ball cannot flip off a block's underside, however slowly it meets it", () => {
  // A head contact with canSnap set goes through hitGroundNoJump, which keeps
  // the flags the pad cleared. [collidedWithObjectInternal :152150-152153 via
  // :152213; propellPlayer :147680-147681]
  const launched = (blockY: number): Sim =>
    simOn(
      emptyLevel([
        { id: YELLOW_PAD, x: 15, y: 32 },
        { id: 1, x: 60, y: blockY, scaleX: 4 },
      ]),
      {},
      "ball",
    );
  for (const [blockY, tick, fast] of [
    [105, 17, true],
    // The pad fires before the floor is landed on, so the launch starts from
    // where the tick's gravity left the ball, 0.029 low. [checkCollisions
    // :464959 before :464974-465003]
    [150, 58, false],
  ] as const) {
    const sim = launched(blockY);
    let rising = 0;
    for (let i = 0; i < 80 && p1(sim).lastFloorObj !== 101; i++) {
      rising = sim.state.yVel;
      sim.step(NO_INPUT);
    }
    assert.equal(sim.tick, tick, `block at ${blockY}: the ball meets it on tick ${tick}`);
    assert.equal(rising > 5, fast, `block at ${blockY}: it rises into the block at ${rising}`);
    assert.equal(sim.state.onGround, false, `block at ${blockY}: no latch`);
    assert.equal(p1(sim).onGround2, false, `block at ${blockY}: not on the ground either`);
    sim.step(HOLD);
    assert.deepEqual(eventsAt(sim, tick + 1), [], `block at ${blockY}: no flip off the block`);
  }
  const sim = launched(105);
  stepN(sim, NO_INPUT, 17);
  sim.step(HOLD);
  near(sim.state.yVel, -0.129, "yVel");
  const next: string[] = [];
  for (let i = 0; i < 80 && next.length < 3; i++) {
    sim.step(HOLD);
    for (const e of eventsAt(sim, sim.tick)) next.push(`${sim.tick}:${e}`);
  }
  assert.deepEqual(next, ["62:land", "63:flip", "63:jump"]);
});

// --- §17: letter blocks ------------------------------------------------------------

test("a letter block still counts in the pass after the player leaves it", () => {
  // touchedObject sets 2, updateStateVariables takes one off per update. [159667, 153691-153705]
  const sim = simOn(emptyLevel([{ id: LETTER.H, x: 75, y: 45 }]));
  const seen: number[] = [];
  stepN(sim, NO_INPUT, 90, () => seen.push(p1(sim).stateHitHead));
  const expected = seen.map((_, k) => {
    const t = k + 1;
    return t <= 23 ? 0 : t <= 69 ? 2 : t === 70 ? 1 : 0;
  });
  assert.deepEqual(seen, expected);
});

test("a J block cancels only a hold that a pad or ring launched", () => {
  // The J check at LABEL_315 needs +1600, which the press clears. [151985-151986, 160452]
  const sim = simOn(emptyLevel([{ id: LETTER.J, x: 164, y: 45 }]));
  settle(sim);
  stepN(sim, HOLD, 110);
  const seen = sim.events.filter((e) => e.tick > 12 && (e.type === "jump" || e.type === "land")).map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(seen.slice(0, 3), ["13:jump", "115:land", "116:jump"]);

  // A yellow orb taken at the press sets +1600, so the J block on the landing
  // spot lets go of the button; a fresh press in the air clears it again.
  // [ringJump :159941-159942]
  const launched = (j: boolean, repressAt: number | null): Sim => {
    const s = inAir(emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }, ...(j ? [{ id: LETTER.J, x: 195, y: 45 }] : [])]));
    s.step(NO_INPUT);
    for (let k = 2; k <= 140; k++) s.step(k === repressAt ? NO_INPUT : HOLD);
    return s;
  };
  const landings = (s: Sim): string[] =>
    s.events.filter((e) => e.tick > 2 && (e.type === "jump" || e.type === "land")).map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(landings(launched(false, null)), ["137:land", "138:jump"], "no J block: the held landing rejumps");
  const cancelled = launched(true, null);
  assert.deepEqual(landings(cancelled), ["137:land"], "the J block: no rejump");
  assert.equal(cancelled.state.holding, false, "the J block let go of the button");
  assert.deepEqual(landings(launched(true, 60)), ["137:land", "138:jump"], "re-pressed in the air: the hold is the player's own");
});

test("a J block lets go of a launched hold on a head contact too", () => {
  // A platformer cube's head contacts reach the same J check.
  // [collidedWithObjectInternal :152169-152170 via :152213]
  const hitHead = (j: boolean): Sim => {
    const extra = [
      { id: ORB.yellow, x: 15, y: 150 },
      { id: 1, x: 15, y: 240 },
      ...(j ? [{ id: LETTER.J, x: 15, y: 190 }] : []),
    ];
    const s = inAir(emptyLevel(extra, makeHeader({ platformer: true })));
    s.step(NO_INPUT);
    stepN(s, HOLD, 39);
    near(s.state.y, 210, `J ${j}: under the block`);
    near(s.state.yVel, 0, `J ${j}: stopped by it`);
    return s;
  };
  assert.equal(hitHead(false).state.holding, true, "no J block: still held");
  assert.equal(hitHead(true).state.holding, false, "the J block: let go");
});

// --- taps: a press and a release inside one step --------------------------------------

test("a tap inside one step: a grounded cube jumps, flying players do nothing, and only an orb already touched answers", () => {
  // Both commands run in processCommands before update; a flying player's
  // updateJump then finds +1909 and +1910 already cleared. [464029-464045, 159519-159520]
  const cube = simOn(emptyLevel());
  settle(cube);
  cube.step(TAP);
  assert.deepEqual(eventsAt(cube, 13), ["jump"], "cube");
  near(cube.state.yVel, YSTART - CUBE_TICK_GRAVITY, "cube yVel");
  assert.equal(cube.state.holding, false, "cube: let go");

  const ufo = inAir(emptyLevel(), "ufo");
  stepN(ufo, NO_INPUT, 10);
  ufo.step(TAP);
  assert.deepEqual(eventsAt(ufo, 11), [], "UFO: no hop");
  near(ufo.state.yVel, -0.946, "UFO yVel");

  const ship = inAir(emptyLevel(), "ship");
  ship.step(TAP);
  near(ship.state.yVel, -0.069, "ship yVel");

  const level = emptyLevel([{ id: ORB.yellow, x: 20, y: 150 }]);
  const touched = inAir(level);
  touched.step(NO_INPUT);
  touched.step(TAP);
  assert.deepEqual(eventsAt(touched, 2), ["orb#100"], "an orb the last pass touched");
  near(touched.state.yVel, YSTART - CUBE_TICK_GRAVITY, "orb yVel");

  const first = inAir(level);
  first.step(TAP);
  assert.deepEqual(orbTicks(first), [], "the pass after the tap finds the button let go");
  near(first.state.yVel, -CUBE_TICK_GRAVITY, "falling");
});

test("a same-frame down and up replays as a tap", () => {
  const macro = new MacroPlayer({
    framerate: 240,
    inputs: [
      { frame: 5, button: 1, player2: false, down: true },
      { frame: 5, button: 1, player2: false, down: false },
    ],
  });
  assert.equal(macro.at(4).p1.tap, undefined);
  assert.deepEqual(macro.at(5).p1, { jump: false, left: false, right: false, tap: true });
  assert.equal(macro.at(6).p1.tap, undefined);
});
