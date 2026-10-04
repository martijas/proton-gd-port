// Where an object's sprites are drawn among the object layer's batch nodes.
//
// The game does not draw a layer's objects in one pass. GJBaseGameLayer::
// setupLayers gives each of the nine z layers a CCSpriteBatchNode per sprite
// sheet and per blend mode, plus a glow batch and a container for particle
// systems, each a child of the object layer at a fixed z. An object's sprite
// goes into the node its z layer, its blending and its sheet pick
// (parentForZLayer, with the sheet from getParentMode); key 25 then orders it
// among that node's other sprites only. So a GJ_GameSheet fireball at z order
// 9 still draws over PixelSheet art at z order 10 in the same layer: the
// pixel batch sits lower in the layer.
//
// Particle systems sit among the same children. A Custom Particles object's
// goes in its layer's container, at its z order. An object's own system
// (createAndAddParticle) is not in any layer's nodes: it is added to the
// object layer itself at the z its type gave it — 4 for portals and rings,
// 0 for pads, bubbles and keys, −2 for fireballs and boosts — which is over
// all of B1 and under all of T1 whatever layer the object is in.
//
// This file is the transcription: the node z values, the mode an object's id
// picks, and the rules that move a sprite to another node. The draw list
// (drawList.ts) sorts by what these return.
// [gdp GJBaseGameLayer::setupLayers :434370-435747 (the nine particle
//  containers :435227-435275), createTextLayers :419212-419420,
//  parentForZLayer :435748-436250; GameObject::getParentMode
//  :168337-168540, addMainSpriteToParent :169272-169338,
//  addColorSpriteToParent :169340-169420, addColorSpriteToSelf
//  :168641-168670, activateObject :169451-169475. Every node z and every
//  parentForZLayer and getParentMode answer was also read off the 2.2074
//  exe, which agrees with the 2.206 decompile node for node: setupLayers
//  VA 0x140208aa0, createTextLayers 0x14020ed24, parentForZLayer
//  0x14020f160, getParentMode 0x14019ab30 (its id table at image base +
//  0x19ac20). The decompile's parentForZLayer has no case 4, which routes
//  mode 4 to the containers; the exe's does, VA 0x14020f34f-0x14020f407,
//  returning the same fields setupLayers keeps the containers in.]

import { LAYER_Z } from "../triggers/shaderState";

/** getParentMode's answers: which sheet's batches an object's sprites go in. */
export const PARENT_MODE = {
  /** GJ_GameSheet, and anything the table does not name. */
  GAME: 0,
  GAME_02: 1,
  /** The text objects' font. */
  TEXT: 2,
  FIRE: 3,
  /** A plain node per layer, which the particle systems share: not a batch. */
  CONTAINER: 4,
  /** GJ_GameSheetGlow: an object's glow, whatever its own mode. */
  GLOW: 5,
  PIXEL: 6,
  PARTICLE: 8,
} as const;

/**
 * The ids getParentMode sends to a sheet other than GJ_GameSheet, as
 * [first, last, mode]. Read off the 2.2074 exe's jump table, which matches
 * the 2.206 decompile's tree. [GameObject::getParentMode :168337-168540;
 *  exe VA 0x14019ab30]
 */
const MODE_RANGES: readonly (readonly [number, number, number])[] = [
  [142, 142, 1], [914, 914, 2], [918, 918, 3], [920, 921, 3], [923, 924, 3], [1327, 1328, 3], [1329, 1329, 1],
  [1584, 1584, 3], [1614, 1614, 3], [1615, 1615, 4], [1618, 1618, 3], [1816, 1816, 3], [1844, 1858, 3],
  [1860, 1860, 3], [1919, 1928, 1], [1936, 1939, 3], [1964, 1964, 1], [2012, 2012, 3], [2020, 2055, 3],
  [2063, 2063, 1], [2070, 2700, 6], [2703, 2704, 1], [2708, 2770, 1], [2773, 2773, 1], [2776, 2863, 1],
  [2864, 2865, 3], [2867, 2894, 3], [2895, 2897, 1], [2927, 2998, 1], [3000, 3002, 3], [3034, 3091, 1],
  [3092, 3097, 6], [3101, 3599, 6], [3601, 3601, 1], [3646, 3654, 8], [3656, 3659, 8], [3700, 3799, 6],
  [3801, 3999, 8], [4000, 4399, 6], [4401, 4539, 6],
];

/**
 * The objects customSetup puts in their layer's container (+656), which
 * getParentMode answers before its table. [GameObject::customSetup :177925,
 *  :178419, :178478; traced by tools/ref-trace-ida-customsetup.py]
 */
const CONTAINER_IDS: ReadonlySet<number> = new Set([1755, 1813, 1816, 1829, 1859, 2069, 2866, 3610, 3611, 3645]);

/**
 * The objects customSetup puts in GJ_GameSheet02's batches (+908), which
 * getParentMode answers next: the portals and most triggers. A portal's back
 * half gets it too, as PlayLayer::addObject makes it (PORTAL_BACK_MODE).
 * [GameObject::customSetup :177387…:179856; traced by
 *  tools/ref-trace-ida-customsetup.py]
 */
const GAME_SHEET_02_RANGES: readonly (readonly [number, number])[] = [
  [10, 13], [22, 34], [44, 47], [55, 59], [99, 99], [101, 101], [105, 105], [111, 111], [200, 203], [221, 221],
  [286, 287], [660, 660], [717, 718], [743, 745], [747, 747], [749, 749], [899, 901], [915, 915], [1006, 1007],
  [1049, 1049], [1268, 1268], [1331, 1331], [1334, 1334], [1346, 1347], [1520, 1520], [1585, 1585], [1595, 1595],
  [1611, 1613], [1616, 1616], [1811, 1812], [1814, 1819], [1912, 1917], [1931, 1935], [2015, 2016], [2062, 2068],
  [2899, 2905], [2907, 2907], [2909, 2917], [2919, 2926], [2999, 2999], [3006, 3024], [3029, 3033], [3600, 3600],
  [3602, 3609], [3612, 3615], [3617, 3620], [3640, 3643], [3655, 3655], [3660, 3662],
];

/** A portal's back half: GJ_GameSheet02. [PlayLayer::addObject :90144, :90179 (+908)] */
export const PORTAL_BACK_MODE = PARENT_MODE.GAME_02;

function inRanges(id: number, ranges: readonly (readonly [number, number, ...number[]])[]): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (id < r[0]) hi = mid - 1;
    else if (id > r[1]) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * The sheet an object's sprites are batched with. Every object the shipped
 * table draws has its frames on exactly this sheet (test/batch.test.ts), as
 * cocos needs: a batch draws everything in it from its one texture.
 * [GameObject::getParentMode :168337-168540]
 */
export function parentMode(id: number): number {
  if (CONTAINER_IDS.has(id)) return PARENT_MODE.CONTAINER;
  if (inRanges(id, GAME_SHEET_02_RANGES) >= 0) return PARENT_MODE.GAME_02;
  const at = inRanges(id, MODE_RANGES);
  return at >= 0 ? MODE_RANGES[at][2] : PARENT_MODE.GAME;
}

/**
 * The objects whose colour sprite stays on the object whatever the two
 * halves' blending (+552): addColorSpriteToParent leaves it alone, so it
 * never gets a batch of its own. commonInteractiveSetup sets it on the coins
 * and keys; customSetup on the beasts and the waterfall. [GameObject::
 *  addColorSpriteToParent :169340-169346; commonInteractiveSetup
 *  :171250-171262; traced by tools/ref-trace-ida-customsetup.py]
 */
const COLOUR_STAYS_RANGES: readonly (readonly [number, number])[] = [
  [918, 918], [1275, 1276], [1327, 1328], [1516, 1516], [1584, 1584], [1587, 1590], [1598, 1599], [1614, 1614],
  [2012, 2012], [3601, 3601], [4401, 4539],
];

export function colourSpriteStays(id: number): boolean {
  return inRanges(id, COLOUR_STAYS_RANGES) >= 0;
}

/**
 * The objects whose colour sprite sits in front of them (+909):
 * addColorSpriteToSelf hangs it on the object at z 100 rather than −100, a
 * colour sprite that blends while the main half does not goes up a layer
 * (addColorSpriteToParent), and a main half that blends while the colour
 * sprite does not stays where it is (addMainSpriteToParent). customSetup
 * sets it, and commonInteractiveSetup on the coins and keys. Only the
 * objects with a colour sprite read it. [GameObject::addColorSpriteToSelf
 *  :168655-168660, addMainSpriteToParent :169290-169292,
 *  addColorSpriteToParent :169385-169386; commonInteractiveSetup
 *  :171250-171262; traced by tools/ref-trace-ida-customsetup.py into
 *  data/ref/customSetup_render_flags_2206.json]
 */
const COLOUR_IN_FRONT_RANGES: readonly (readonly [number, number])[] = [
  [841, 848], [850, 850], [853, 857], [859, 859], [861, 863], [867, 874], [877, 878], [880, 885], [888, 891],
  [893, 896], [907, 910], [916, 917], [939, 942], [1062, 1062], [1159, 1161], [1247, 1259], [1266, 1267],
  [1275, 1290], [1348, 1395], [1431, 1464], [1471, 1473], [1496, 1496], [1507, 1507], [1510, 1517], [1582, 1583],
  [1587, 1591], [1593, 1593], [1599, 1601], [1614, 1614], [1617, 1617], [1621, 1684], [1764, 1796], [1799, 1810],
  [1843, 1856], [1858, 1858], [1861, 1885], [1919, 1928], [1964, 1964], [2070, 2700], [2703, 2704], [2708, 2770],
  [2773, 2773], [2776, 2863], [2927, 2998], [3086, 3086], [3088, 3088], [3092, 3097], [3101, 3541], [3544, 3599],
  [3621, 3639], [3700, 3799], [4000, 4399], [4401, 4539],
];

export function colourSpriteInFront(id: number): boolean {
  return inRanges(id, COLOUR_IN_FRONT_RANGES) >= 0;
}

/**
 * Whether a level's capacity string (GJGameLevel +772) marks it as made
 * before 2.0's layers (+2628): a string of 16 to 54 numbers joined by "_".
 * Then every text and fire sprite goes in B1's batches, whatever its layer
 * (batchZ's `legacy`). The official levels up to Deadlocked and The
 * Challenge carry one; an online level's comes with it from the servers.
 * A trailing "_" makes no empty last number, an empty one between two
 * does. [GJBaseGameLayer::updateLayerCapacity :438552-438830 (set
 *  :438751, cleared :438815; split by sub_4524A8 :415461-415490), called
 *  from PlayLayer::init :106199-106201; cleared in the constructor :98129]
 */
export function legacyLayers(capacity: string | undefined): boolean {
  if (!capacity || capacity.includes(",")) return false;
  const n = capacity.split("_").length - (capacity.endsWith("_") ? 1 : 0);
  return n > 15 && n <= 54;
}

/** A node parentForZLayer hands back that setupLayers never made: what goes there is never drawn. */
export const NO_NODE = 0x7fff;

/**
 * Which band of parentForZLayer's tree a key-24 layer falls in: B5, B4, B3,
 * B2, B1, the in-between layer 4, T1, T2, T3, T4, and 12 up. Layer 4 is
 * where an object in B1 goes when its main half blends and its colour
 * sprite does not, and where a portal's back half is put; 12 is the same for
 * T4. The odd layers in between (−4, −2, 0, 2, 6, 8, 10) fall in with the
 * layer above them. [parentForZLayer :435785-436250]
 */
function band(layer: number): number {
  if (layer <= -5) return 0;
  if (layer <= -3) return 1;
  if (layer <= -1) return 2;
  if (layer <= 1) return 3;
  if (layer <= 3) return 4;
  if (layer === 4) return 5;
  if (layer === 5) return 6;
  if (layer <= 7) return 7;
  if (layer <= 9) return 8;
  if (layer <= 11) return 9;
  return 10;
}

/**
 * The z of each node in the object layer, by band, plain then additive. A
 * layer's nodes sit, bottom to top: glow, particle sheet, pixel sheet,
 * GJ_GameSheet02, fire sheet, container, GJ_GameSheet — each sheet's
 * additive node just under its plain one, but the text font's just over.
 * Layer 4 has additive nodes of its own just over B1's, and a plain
 * GJ_GameSheet02 node at −5 for the portals' back halves; its other plain
 * sprites go to T1's. Twelve and up has additive nodes over T4's. The
 * particle sheet has no additive node for layer 4: setupLayers never makes
 * it. [setupLayers :434825-435747; createTextLayers :419300-419400; the
 *  containers, exe VA 0x140209b60-0x140209c90]
 */
const NODE_Z: Readonly<Record<number, readonly [readonly number[], readonly number[]]>> = {
  [PARENT_MODE.GAME]: [
    [-1220, -920, -620, -320, -20, 360, 360, 660, 960, 1340, 1340],
    [-1240, -940, -640, -340, -40, -10, 340, 640, 940, 1320, 1360],
  ],
  [PARENT_MODE.GAME_02]: [
    [-1360, -1060, -760, -460, -160, -5, 220, 520, 820, 1160, 1160],
    [-1380, -1080, -780, -480, -180, -150, 200, 500, 800, 1140, 1180],
  ],
  [PARENT_MODE.TEXT]: [
    [-1300, -1000, -700, -400, -100, 280, 280, 580, 880, 1260, 1260],
    [-1280, -980, -680, -380, -80, 300, 300, 600, 900, 1280, 1280],
  ],
  [PARENT_MODE.FIRE]: [
    [-1320, -1020, -720, -420, -120, 260, 260, 560, 860, 1220, 1220],
    [-1340, -1040, -740, -440, -140, -110, 240, 540, 840, 1200, 1240],
  ],
  [PARENT_MODE.CONTAINER]: [
    [-1260, -960, -660, -360, -60, 320, 320, 620, 920, 1300, 1300],
    [-1260, -960, -660, -360, -60, 320, 320, 620, 920, 1300, 1300],
  ],
  [PARENT_MODE.GLOW]: [
    [-1480, -1180, -880, -580, -280, -280, 120, 410, 710, 1010, 1010],
    [-1480, -1180, -880, -580, -280, -280, 120, 410, 710, 1010, 1010],
  ],
  [PARENT_MODE.PIXEL]: [
    [-1400, -1100, -800, -500, -200, 180, 180, 480, 780, 1100, 1100],
    [-1420, -1120, -820, -520, -220, -190, 160, 460, 760, 1080, 1120],
  ],
  [PARENT_MODE.PARTICLE]: [
    [-1430, -1130, -830, -530, -224, 154, 154, 454, 754, 1070, 1070],
    [-1432, -1132, -832, -532, -226, NO_NODE, 150, 450, 750, 1066, 1074],
  ],
};

/** B1's band, where a legacy level's text and fire sprites all go. */
const B1_BAND = 4;

/**
 * The z of the node parentForZLayer puts a sprite in: by its key-24 layer
 * (as getObjectZLayer reads it, plus one where the game moves it up), its
 * blending, and its mode. NO_NODE where the game has none. Modes the game
 * does not know fall to GJ_GameSheet, as its switch does. In a level made
 * before 2.0's layers (`legacy`, legacyLayers) the text and fire sprites go
 * in B1's batches whatever their layer.
 * [GJBaseGameLayer::parentForZLayer :435748-436250; the +2628 tests, additive
 *  :435877 (text → +484) and :435929 (fire → +486), plain :436084 (text →
 *  +483) and :436136 (fire → +485); the exe's at 0x14020f6c2 and 0x14020f7a6]
 */
export function batchZ(layer: number, blend: boolean, mode: number, legacy = false): number {
  const nodes = NODE_Z[mode] ?? NODE_Z[PARENT_MODE.GAME];
  const b = legacy && (mode === PARENT_MODE.TEXT || mode === PARENT_MODE.FIRE) ? B1_BAND : band(layer);
  return nodes[blend ? 1 : 0][b];
}

/** The z order a glow is added to its batch at: every glow ties, so they go in the order they came. [activateObject :169466-169471] */
export const GLOW_Z_ORDER = -1000;

/**
 * Where a Custom Particles object's system draws: its layer's container,
 * among the container's other systems by its object's z order (key 25).
 * [ParticleGameObject::addMainSpriteToParent :301723-301759 →
 *  parentForZLayer(layer, false, 4), addChild at getObjectZOrder]
 */
export function containerZ(layer: number): number {
  return batchZ(layer, false, PARENT_MODE.CONTAINER);
}

/**
 * Which of the nine draw layers (LAYER_Z's slots) a z in the object layer
 * falls in: by the ranges the screen-effect bands split the object layer at,
 * which every batch's z sits inside. [GJBaseGameLayer::minZOrderForShaderZ,
 *  shaderState.minZOrder]
 */
export function slotOfZ(z: number): number {
  if (z < -1200) return 0;
  if (z < -900) return 1;
  if (z < -600) return 2;
  if (z < -300) return 3;
  if (z < 39) return 4;
  if (z < 400) return 5;
  if (z < 700) return 6;
  if (z < 1000) return 7;
  return LAYER_Z.length - 1;
}

/** A buffer's draws by batch z, as DrawList and ParticleField hand them out after a gather. */
export interface ZRuns {
  readonly runZ: Int16Array;
  readonly runStart: Int32Array;
  readonly runCount: Int32Array;
  readonly layerRunFirst: Int32Array;
  readonly layerRuns: Int32Array;
}

/** A buffer's z runs with how many there are, as ParticleField and CircleWaves keep them. */
export interface CountedRuns extends ZRuns {
  readonly runs: number;
}

/**
 * What drawLayerRuns and drawParticleRuns hand each draw to: 0 for the
 * sprites' buffer, 1 for the particle systems', 2 for the circle waves'.
 */
export type RunDraw = (buffer: 0 | 1 | 2, count: number, start: number) => void;

/**
 * The two overlays drawLayerRuns and drawParticleRuns walk among the
 * batches — [0] the particle systems' runs, [1] the circle waves' — and how
 * far each walk has got in the draw layer. Both are children of the object
 * layer at a z of their own, and each buffer is in z order. Module scratch,
 * as the draws never nest and run nine times a frame.
 */
const overlayRuns: (ZRuns | null)[] = [null, null];
const overlayAt = new Int32Array(2);
const overlayEnd = new Int32Array(2);

/** Starts walking overlay `k`'s runs in draw layer `slot`, those at `from` and over and under `until`. */
function openOverlay(k: 0 | 1, runs: ZRuns | null, slot: number, from: number, until: number): void {
  overlayRuns[k] = runs;
  if (!runs) {
    overlayAt[k] = overlayEnd[k] = 0;
    return;
  }
  let at = runs.layerRunFirst[slot];
  let end = at + runs.layerRuns[slot];
  while (at < end && runs.runZ[at] < from) at++;
  while (end > at && runs.runZ[end - 1] >= until) end--;
  overlayAt[k] = at;
  overlayEnd[k] = end;
}

/** The z of overlay `k`'s next run, Infinity when it has none left. */
function overlayHead(k: 0 | 1): number {
  const runs = overlayRuns[k];
  return runs && overlayAt[k] < overlayEnd[k] ? runs.runZ[overlayAt[k]] : Infinity;
}

/**
 * Draws the overlays' runs under z `below` in z order, the particle
 * systems' before the circles' at a tie — the systems are claimed as their
 * objects come on screen, before any circle made while they are there, and
 * cocos breaks a tie by arrival. Each stretch of one buffer's runs with
 * nothing of the other between them is one draw: a buffer in z order has
 * them next to each other.
 */
function drawOverlaysBelow(below: number, draw: RunDraw): void {
  for (;;) {
    const zp = overlayHead(0);
    const zc = overlayHead(1);
    const k: 0 | 1 = zp <= zc ? 0 : 1;
    if (!((k === 0 ? zp : zc) < below)) return;
    const other = k === 0 ? zc : zp;
    const runs = overlayRuns[k] as ZRuns;
    const start = runs.runStart[overlayAt[k]];
    let count = 0;
    while (overlayAt[k] < overlayEnd[k]) {
      const z = runs.runZ[overlayAt[k]];
      if (z >= below || (k === 0 ? z > other : z >= other)) break;
      count += runs.runCount[overlayAt[k]];
      overlayAt[k]++;
    }
    draw(k === 0 ? 1 : 2, count, start);
  }
}

/**
 * One draw layer's sprites, particle systems and circle waves in the object
 * layer's order: the sprites batch by batch, each particle or circle run
 * before the first batch above its z (at a tie the batch, which was added
 * first, goes first). Runs of one buffer with nothing of another between
 * them are handed over as one draw. Particle and circle runs at `until` and
 * over are left for drawParticleRuns: B1's from the streak up, which go over
 * the streak.
 */
export function drawLayerRuns(sprites: ZRuns, particles: ZRuns | null, slot: number, draw: RunDraw, until = NO_NODE, circles: ZRuns | null = null): void {
  openOverlay(0, particles, slot, -Infinity, until);
  openOverlay(1, circles, slot, -Infinity, until);
  const r0 = sprites.layerRunFirst[slot];
  const rEnd = r0 + sprites.layerRuns[slot];
  let from = sprites.layerRuns[slot] > 0 ? sprites.runStart[r0] : 0;
  let held = 0;
  for (let r = r0; r < rEnd; r++) {
    const z = sprites.runZ[r];
    if (overlayHead(0) < z || overlayHead(1) < z) {
      if (held > 0) draw(0, held, from);
      from += held;
      held = 0;
      drawOverlaysBelow(z, draw);
    }
    held += sprites.runCount[r];
  }
  if (held > 0) draw(0, held, from);
  drawOverlaysBelow(Infinity, draw);
}

/**
 * A draw layer's particle and circle runs at z `from` and over, in z order:
 * what drawLayerRuns left at its own `until` and over.
 */
export function drawParticleRuns(particles: ZRuns | null, slot: number, from: number, draw: RunDraw, circles: ZRuns | null = null): void {
  openOverlay(0, particles, slot, from, Infinity);
  openOverlay(1, circles, slot, from, Infinity);
  drawOverlaysBelow(Infinity, draw);
}
