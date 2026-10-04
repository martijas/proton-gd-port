// Hand-built levels for the physics tests: a flat floor of id 1 blocks and
// whatever a test places on it, so every number follows from the constants.

import assert from "node:assert/strict";
import type { GameMode, Level, LevelHeader, LevelObject } from "../src/level/types";
import type { PlayerInput, Sim, StartState } from "../src/physics/types";
import { NO_INPUT } from "../src/physics/types";
import { makeSim } from "./helpers";

export const HOLD: PlayerInput = Object.freeze({ jump: true, left: false, right: false });
export const BLOCK = 30;

export function makeHeader(over: Partial<LevelHeader> = {}): LevelHeader {
  return {
    startMode: "cube",
    startSpeed: 1,
    startMini: false,
    startDual: false,
    startFlipped: false,
    startReversed: false,
    startRotated: false,
    spawnGroup: 0,
    twoPlayer: false,
    platformer: false,
    playerSqueeze: false,
    fixGravityBug: false,
    fixRobotJump: false,
    enable22Changes: false,
    sortAllGroupsX: false,
    ySections: false,
    fixRadiusCollision: false,
    allowMultiRotation: true,
    allowStaticRotate: true,
    reverseSync: false,
    fixNegativeScale: true,
    lengthSteps: 0,
    decreaseBoostSlide: false,
    leftStopAlways: false,
    noLeftStop: false,
    songOffset: 0,
    fadeIn: false,
    fadeOut: false,
    background: 1,
    ground: 1,
    groundLine: 0,
    font: 1,
    guidelines: [],
    colors: new Map(),
    raw: {},
    ...over,
  };
}

export interface Placed {
  id: number;
  x: number;
  y: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  scaleX?: number;
  scaleY?: number;
  /** Extra raw keys, merged into the object's props. */
  props?: Record<number, string>;
  /** A start position's settings block (kA2 …), as the decoder keeps it. */
  settings?: Record<string, string>;
}

export function buildLevel(placed: Placed[], header = makeHeader()): Level {
  const objects: LevelObject[] = placed.map((p, index) => ({
    index,
    id: p.id,
    x: p.x,
    y: p.y,
    rotation: p.rotation ?? 0,
    flipX: p.flipX ?? false,
    flipY: p.flipY ?? false,
    scaleX: p.scaleX ?? 1,
    scaleY: p.scaleY ?? 1,
    groups: [],
    zLayer: null,
    zOrder: null,
    baseColor: null,
    detailColor: null,
    legacyColor: null,
    baseHsv: null,
    detailHsv: null,
    editorLayer: null,
    props: { 1: String(p.id), 2: String(p.x), 3: String(p.y), ...(p.props ?? {}) },
    settings: p.settings ?? null,
  }));
  const maxX = objects.reduce((m, o) => Math.max(m, o.x), 0);
  return { header, objects, lengthUnits: maxX + BLOCK * 12 };
}

/** Solid id 1 blocks centred at y, covering x0..x1 (block edges on multiples of 30). */
export function floor(x0: number, x1: number, y = 15): Placed[] {
  const out: Placed[] = [];
  for (let x = x0 + 15; x < x1; x += BLOCK) out.push({ id: 1, x, y });
  return out;
}

/** Empty level: floor from x = 0 to 3000 at y = 15 (block tops at 30), nothing else. */
export function emptyLevel(extra: Placed[] = [], header = makeHeader()): Level {
  return buildLevel([...floor(0, 3000), ...extra], header);
}

/** Player standing on the floor: centre 15 above the block tops. */
export const STANDING_Y = 45;

export function simOn(level: Level, start: Partial<StartState> = {}, mode: GameMode = "cube"): Sim {
  return makeSim(level, undefined, { start: { x: 15, y: STANDING_Y, mode, ...start } });
}

export function stepN(sim: Sim, input: PlayerInput, n: number, each?: (sim: Sim) => void): void {
  for (let i = 0; i < n; i++) {
    sim.step(input);
    each?.(sim);
    if (sim.state.dead) throw new Error(`died at tick ${sim.tick} (x=${sim.state.x.toFixed(1)}, y=${sim.state.y.toFixed(1)})`);
  }
}

export function settle(sim: Sim): number {
  // A mini player starts 6 units above its standing height and needs ~16 ticks to land.
  stepN(sim, NO_INPUT, 12);
  for (let guard = 0; guard < 240 && !sim.state.onGround; guard++) stepN(sim, NO_INPUT, 1);
  assert.ok(sim.state.onGround, "player should be standing on the floor before the jump");
  return sim.state.y;
}
