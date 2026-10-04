// Baseline: what the port currently does to y velocity and rotation across
// every mode portal. Throwaway — the numbers go into a real test once the
// decompile extraction says what they should be.

import type { GameMode, Level, LevelHeader, LevelObject } from "../../src/level/types";
import { NO_INPUT, type PlayerInput, type Sim } from "../../src/physics/types";
import { makeSim } from "../../test/helpers";

const BLOCK = 30;
const HOLD: PlayerInput = { jump: true, left: false, right: false };
const PORTAL_ID: Record<GameMode, number> = {
  cube: 12,
  ship: 13,
  ball: 47,
  ufo: 111,
  wave: 660,
  robot: 745,
  spider: 1331,
  swing: 1933,
};

function header(): LevelHeader {
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
  };
}

function build(placed: { id: number; x: number; y: number }[]): Level {
  const objects: LevelObject[] = placed.map((p, index) => ({
    index,
    id: p.id,
    x: p.x,
    y: p.y,
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
    props: { 1: String(p.id), 2: String(p.x), 3: String(p.y) },
    settings: null,
  }));
  return { header: header(), objects, lengthUnits: 6000 };
}

/**
 * Flies `from` mode along a corridor to a portal that switches to `to`, and
 * reports the y velocity and rotation either side of the switch.
 */
function run(level: Level, from: GameMode, hold: boolean, ticks: number, at?: (sim: Sim) => void): Sim {
  const sim: Sim = makeSim(level, undefined, { start: { x: 15, y: 45, mode: from }, noclip: true });
  const input = hold ? HOLD : NO_INPUT;
  for (let t = 0; t < ticks; t++) {
    sim.step(input);
    at?.(sim);
    if (sim.state.dead || sim.state.finished) break;
  }
  return sim;
}

/** A floor so the grounded modes have something to stand on. */
function floor(): { id: number; x: number; y: number }[] {
  const out: { id: number; x: number; y: number }[] = [];
  for (let x = 15; x < 3000; x += BLOCK) out.push({ id: 1, x, y: 15 });
  return out;
}

const PORTAL_X = 160;

/**
 * Pass one finds where the player is when it reaches the portal's x; pass two
 * puts the portal there so the switch actually happens, whatever the mode was
 * doing to the player's height.
 */
function cross(from: GameMode, to: GameMode, hold: boolean): string {
  let portalY: number | null = null;
  run(build(floor()), from, hold, 900, (sim) => {
    if (portalY === null && sim.state.x >= PORTAL_X) portalY = sim.state.y;
  });
  if (portalY === null) return `${from} -> ${to}  (never reached x=${PORTAL_X})`;

  const level = build([...floor(), { id: PORTAL_ID[to], x: PORTAL_X, y: portalY }]);
  let before: { yVel: number; rot: number } | null = null;
  let after: { yVel: number; rot: number } | null = null;
  let prev = { yVel: 0, rot: 0 };
  run(level, from, hold, 900, (sim) => {
    if (after === null && sim.state.mode === to && before === null) {
      before = prev;
      after = { yVel: sim.state.yVel, rot: sim.state.rotation };
    }
    prev = { yVel: sim.state.yVel, rot: sim.state.rotation };
  });
  if (!before || !after) return `${from.padEnd(7)} -> ${to.padEnd(7)} ${hold ? "held" : "free"}  (portal missed at y=${(portalY as number).toFixed(0)})`;
  const b = before as { yVel: number; rot: number };
  const a = after as { yVel: number; rot: number };
  const ratio = Math.abs(b.yVel) < 1e-9 ? "-" : (a.yVel / b.yVel).toFixed(3);
  return (
    `${from.padEnd(7)} -> ${to.padEnd(7)} ${hold ? "held " : "free "}` +
    ` yVel ${b.yVel.toFixed(3).padStart(8)} -> ${a.yVel.toFixed(3).padStart(8)}  x${ratio.padStart(7)}` +
    `   rot ${b.rot.toFixed(1).padStart(7)} -> ${a.rot.toFixed(1).padStart(7)}`
  );
}

const MODES: GameMode[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"];
console.log("what the port does across a mode portal today\n");
for (const hold of [true, false]) {
  for (const from of MODES) {
    for (const to of MODES) {
      if (from === to) continue;
      console.log("  " + cross(from, to, hold));
    }
  }
  console.log("");
}
