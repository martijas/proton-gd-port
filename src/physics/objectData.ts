// Manual object knowledge: what the engine knows about specific object ids that
// the fan-port bootstrap table (data/objects-bootstrap.json) gets wrong, leaves
// out, or cannot express (slopes, off-centre hazard rects, portal effects).
//
// Sources (see research_level-format.md §4–§7):
//   [O] OpenGD object.json `object_type` + LongData.cpp hitbox tables (2.1 ids)
//   [P] reference fan port (_SLOPE_DATA, portal sub kinds, 2.2 grid sizes)
//   [C] gdcreatorschool hitbox guides
//   [K] Geode GameObjectType values 41–47 (2.2 additions)
//   [S] real install sprite sheets (frame sizes, uhd = 4 px per unit)
//
// Units: GD units (1 block = 30). Rects are w×h about the object centre plus an
// (ox, oy) offset of the rect centre; circles are r about the centre + offset.
// Everything here is exported so the tests can cross-check the built table.

import type { GameMode, Speed } from "../level/types";
import type { OrbType, PadType, PortalEffect } from "./types";

export interface RectSize {
  w: number;
  h: number;
}

export interface RectWithOffset extends RectSize {
  /** Offset of the rect *centre* from the object centre. */
  ox: number;
  oy: number;
}

// ---------------------------------------------------------------------------
// Portals — GameObjectType 3–6, 14–20, 23, 24, 26–28, 33, 41, 42 [O][K]
// ---------------------------------------------------------------------------

export interface PortalEntry extends RectSize {
  effect: PortalEffect;
  /** The box's centre off the object's own, before the object's flip, scale and turn. */
  ox?: number;
}

const MODE_PORTAL = (mode: GameMode, w = 34, h = 86): PortalEntry => ({ w, h, effect: { type: "mode", mode } });
const SPEED_PORTAL = (speed: Speed, w: number, h: number): PortalEntry => ({ w, h, effect: { type: "speed", speed } });

/** Rect sizes are OpenGD's mined hitboxes [O]; the 2.2 ids use the port's grid size [P]. */
export const PORTALS: ReadonlyMap<number, PortalEntry> = new Map<number, PortalEntry>([
  [12, MODE_PORTAL("cube")],
  [13, MODE_PORTAL("ship")],
  [47, MODE_PORTAL("ball")],
  [111, MODE_PORTAL("ufo")],
  [660, MODE_PORTAL("wave")],
  [745, MODE_PORTAL("robot")],
  [1331, MODE_PORTAL("spider")],
  [1933, MODE_PORTAL("swing", 33.5, 85)],
  // 10 blue / 11 yellow *set* gravity; they are not toggles [O][P].
  [10, { w: 25, h: 75, effect: { type: "gravity", flipped: false } }],
  [11, { w: 25, h: 75, effect: { type: "gravity", flipped: true } }],
  [2926, { w: 23.75, h: 75.5, effect: { type: "gravityToggle" } }],
  [45, { w: 44, h: 92, effect: { type: "mirror", mirrored: true } }],
  [46, { w: 44, h: 92, effect: { type: "mirror", mirrored: false } }],
  [101, { w: 31, h: 90, effect: { type: "size", mini: true } }],
  [99, { w: 31, h: 90, effect: { type: "size", mini: false } }],
  // Speed portal index follows level/types.ts Speed (0 = 0.5x … 4 = 4x); the
  // level header's kA4 enum is remapped by the decoder, not here.
  [200, SPEED_PORTAL(0, 35, 44)],
  [201, SPEED_PORTAL(1, 33, 56)],
  [202, SPEED_PORTAL(2, 51, 56)],
  [203, SPEED_PORTAL(3, 65, 56)],
  [1334, SPEED_PORTAL(4, 69, 56)],
  [286, { w: 41, h: 91, effect: { type: "dual", dual: true } }],
  [287, { w: 41, h: 91, effect: { type: "dual", dual: false } }],
  // 747 is the saved blue half of the linked pair; the game draws the orange
  // exit (749) itself at y + key 54. 2064/2902 are the 2.2 group-targeted pair.
  // Both entries are 25 wide and as tall as their art (90), and the box sits
  // 12 along the portal's own x from its centre, over the visible half of a
  // sprite whose art is trimmed to the right: a player going right meets it
  // 12 units later than a centred box. [gdp GameObject::customSetup
  // LABEL_961, gd-ida-decomp.cpp:179044-179052 (type 28, box offset (12, 0),
  // m_width 25), reached by 747 (:178961) and 2902 (:178189-178198); the
  // height is the content size commonSetup copies (:166725-166726),
  // portal_15_front_001.png's 360 uhd pixels; getBoxOffset turns the offset
  // with the object :170767-170800]
  [747, { w: 25, h: 90, ox: 12, effect: { type: "teleport", kind: "linkedEntry" } }],
  [749, { w: 38.5, h: 90, effect: { type: "teleport", kind: "linkedExit" } }],
  [2902, { w: 25, h: 90, ox: 12, effect: { type: "teleport", kind: "targetEntry" } }],
  [2064, { w: 38.5, h: 90, effect: { type: "teleport", kind: "targetExit" } }],
]);

// ---------------------------------------------------------------------------
// Orbs — all 36×36 centred [O]; the port's 1.2×1.2 grid agrees.
// ---------------------------------------------------------------------------

export const ORB_SIZE = 36;

export const ORBS: ReadonlyMap<number, OrbType> = new Map<number, OrbType>([
  [36, "yellow"],
  [141, "pink"],
  [1333, "red"],
  [84, "blue"],
  [1022, "green"],
  [1330, "black"],
  [1594, "toggle"],
  [1704, "dash"],
  [1751, "dashGravity"],
  [3004, "spider"],
  [3027, "teleport"],
]);

// ---------------------------------------------------------------------------
// Pads — thin strips centred on the sprite centre [O]; 3005 from the port grid [P].
// ---------------------------------------------------------------------------

export interface PadEntry extends RectSize {
  pad: PadType;
}

export const PADS: ReadonlyMap<number, PadEntry> = new Map<number, PadEntry>([
  [35, { pad: "yellow", w: 25, h: 4 }],
  [140, { pad: "pink", w: 25, h: 5 }],
  [1332, { pad: "red", w: 29, h: 7 }],
  [67, { pad: "blue", w: 25, h: 6 }],
  [3005, { pad: "spider", w: 28.5, h: 11 }],
]);

// ---------------------------------------------------------------------------
// Collectibles — SecretCoin 22, UserCoin 31, Collectible 30 [O]
// ---------------------------------------------------------------------------

export interface CollectibleEntry extends RectSize {
  collectible: "secretCoin" | "userCoin" | "item" | "key" | "clock";
}

const PIXEL_COLLECTIBLE_RANGE = { from: 4401, to: 4539 } as const;
const PIXEL_KEY_IDS: ReadonlySet<number> = new Set([4404, 4405, 4406]);

function buildCollectibles(): Map<number, CollectibleEntry> {
  const m = new Map<number, CollectibleEntry>([
    [142, { collectible: "secretCoin", w: 40, h: 40 }],
    [1329, { collectible: "userCoin", w: 40, h: 40 }],
    [1614, { collectible: "item", w: 25, h: 20 }],
    [1275, { collectible: "key", w: 25, h: 20 }],
    [3601, { collectible: "clock", w: 25, h: 20 }],
  ]);
  // 2.2 pixel collectables are 1×1 grid objects; the game's rect is ≈ the sprite.
  for (let id = PIXEL_COLLECTIBLE_RANGE.from; id <= PIXEL_COLLECTIBLE_RANGE.to; id++) {
    m.set(id, { collectible: PIXEL_KEY_IDS.has(id) ? "key" : "item", w: 30, h: 30 });
  }
  return m;
}

export const COLLECTIBLES: ReadonlyMap<number, CollectibleEntry> = buildCollectibles();

// ---------------------------------------------------------------------------
// Gameplay markers with a 30×30 footprint (scaled by keys 32/128/129 at runtime)
// ---------------------------------------------------------------------------

export const CHECKPOINT_ID = 2063;
export const START_POS_ID = 31;
/** 1816 collision block, 3640 collision state block — OBBs the player never lands on. */
export const COLLISION_IDS: readonly number[] = [1816, 3640];
export const TOGGLE_BLOCK_ID = 3643;
/**
 * 2069 force block is a box (its 30-unit sprite), 3645 force circle a
 * radius-15 disc; both are type 40. [gdp GameObject::customSetup,
 *  gd-ida-decomp.cpp:178414-178421, the radius :178480-178482 via :178501-178505]
 */
export const FORCE_BLOCK_IDS: readonly number[] = [2069, 3645];
export const FORCE_CIRCLE_ID = 3645;
export const FORCE_CIRCLE_RADIUS = 15;
/**
 * The 1.x Col 2, Col 3 and Col 4 colour triggers, missing from the bootstrap
 * table. The game makes each a Color Trigger (899) aimed at its channel.
 * [gdp GameObject::objectFromVector :183934-183945, 184244-184264]
 */
export const LEGACY_TRIGGER_IDS: readonly number[] = [717, 718, 743];

const span = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * m_objectType for the animated objects, which EnhancedGameObject::customSetup
 * sets before it hands over to GameObject::customSetup. That one sets none for
 * these ids and leaves it, so they are not the default Solid the generated
 * GAME_OBJECT_TYPES (GameObject::customSetup alone) reads them as: the spinning
 * decorations and fire are Decoration (7), the saws and blades Hazard (2).
 * Where GameObject::customSetup does set a type it wins, being later; no id
 * here has one. [gd-ida-decomp.cpp:181863-182790: 7 at :181946, :181982,
 *  :182119, :182232, :182262, :182330, :182350, :182396, :182424, :182460,
 *  :182609, :182637, :182643, :182670, :182688, :182704, :182725; 2 at
 *  :182026, :182202, :182515, :182736, :182755; 29 at :182285; 32 at :182367;
 *  30 for 1614 through commonInteractiveSetup :171263]
 */
export const ENHANCED_OBJECT_TYPES: ReadonlyMap<number, number> = new Map<number, number>([
  ...[
    ...span(85, 87), 97, ...span(137, 139), ...span(154, 156), ...span(180, 182), ...span(222, 224), ...span(375, 378),
    ...span(394, 396), 920, 921, 923, 924, ...span(997, 1000), ...span(1019, 1021), ...span(1050, 1061), 1516, 1518,
    1519, ...span(1521, 1528), ...span(1591, 1593), 1618, ...span(1697, 1699), 1752, ...span(1831, 1834),
    ...span(1839, 1842), ...span(1849, 1858), 1860, ...span(1936, 1939), ...span(2020, 2055), 2223, 2246, 2605, 2629,
    2630, 2694, 2864, 2865, ...span(2867, 2894), ...span(3000, 3002), ...span(3119, 3121), 3219, 3303, 3304,
    ...span(3482, 3484), 3492, 3493, 4211, 4300,
  ].map((id): [number, number] => [id, 7]),
  ...[
    88, 89, 98, ...span(183, 188), ...span(397, 399), ...span(675, 680), ...span(740, 742), 1582, 1583, 1619, 1620,
    ...span(1705, 1710), ...span(1734, 1736),
  ].map((id): [number, number] => [id, 2]),
  [1022, 29],
  [1330, 32],
  [1614, 30],
]);

/**
 * m_objectType for the ids a GameObject subclass types itself, which beats
 * both tables above. EffectGameObject's and ParticleGameObject's customSetup
 * run EnhancedGameObject::customSetup (and so GameObject::customSetup) first
 * and then set their own: the secret coin 142 is a SecretCoin (22), the user
 * coin 1329 a UserCoin (31), Custom Particles 2065 Decoration (7).
 * EnterEffectObject's init makes its ids EnterEffectObject (45) before any
 * customSetup runs, and for the area triggers 3006-3015 GameObject::customSetup
 * sets nothing to replace it. None of these ids has a type in either table
 * above. [EffectGameObject::customSetup :302330, 142 at :302347-302349, 1329
 *  at :302424-302425; ParticleGameObject::customSetup :298437-298440;
 *  EnterEffectObject::init :307729-307740, made for 3006-3015 by
 *  GameObject::createWithKey :183665-183682]
 */
export const SUBCLASS_OBJECT_TYPES: ReadonlyMap<number, number> = new Map<number, number>([
  [142, 22],
  [1329, 31],
  [2065, 7],
  ...span(3006, 3015).map((id): [number, number] => [id, 45]),
]);

/**
 * m_objectType for the 3DL pieces 506-514 and the perspective blocks, which
 * GameObject::setupCustomSprites makes Decoration (7). objectFromVector calls
 * it after customSetup, a subclass's included, so it beats all three tables
 * above: the perspective slopes 522 and 523, Slope in GAME_OBJECT_TYPES, end
 * up Decoration too. The 3DL pieces take colour channel 1003 and then join the
 * perspective blocks at LABEL_1827, where every perspective path ends. These
 * are the ids whose path through the dispatch reaches it: perspectiveBlockFrame's
 * ids but 1530, which the dispatch leaves untyped. [GameObject::setupCustomSprites
 *  :605579; 506-514 at :613324-613375; LABEL_1827 :613575-613582; 1530 at
 *  :608328-608355, LABEL_302 :611713-611716; ObjectToolbox::perspectiveBlockFrame
 *  :384683; called after customSetup by objectFromVector :184192-184201]
 */
export const CUSTOM_SPRITES_OBJECT_TYPES: ReadonlyMap<number, number> = new Map<number, number>(
  [
    ...span(506, 640), 902, ...span(943, 951), ...span(980, 988), ...span(1024, 1032), ...span(1063, 1071), 1529,
    ...span(1531, 1540), ...span(1552, 1560),
  ].map((id): [number, number] => [id, 7]),
);

// ---------------------------------------------------------------------------
// Solids — GameObjectType 0 (144 ids) + slope corners 296/297/374 + Breakable 143 [O]
// ---------------------------------------------------------------------------

export const BREAKABLE_ID = 143;

/** Letter modifier blocks (GameObjectType Special = 40). They are not walls: the
 *  sim reads `special` and treats the block as a pass-through area that changes
 *  how the solid it overlaps behaves. */
export const SPECIAL_BLOCKS: ReadonlyMap<number, "D" | "J" | "S" | "H" | "F"> = new Map([
  [1755, "D"],
  [1813, "J"],
  [1829, "S"],
  [1859, "H"],
  [2866, "F"],
]);

export const SOLID_IDS: readonly number[] = [
  1, 2, 3, 4, 6, 7, 34, 40, 62, 63, 64, 65, 66, 68, 69, 70, 71, 72, 74, 75, 76, 77, 78, 81, 82, 83, 90, 91, 92, 93, 94, 95,
  96, 116, 117, 118, 119, 121, 122, 146, 147, 160, 161, 162, 163, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
  176, 192, 194, 195, 196, 197, 204, 206, 207, 208, 209, 210, 212, 213, 215, 219, 220, 247, 248, 249, 250, 252, 253, 254,
  255, 256, 257, 258, 260, 261, 263, 264, 265, 267, 268, 269, 270, 271, 272, 274, 275, 328, 329, 369, 370, 661, 662, 663, 664, 1154, 1155, 1156, 1157, 1202, 1203, 1204, 1208, 1209, 1210, 1220, 1221, 1222, 1226,
  1227, 1340, 1343, 1561, 1562, 1563, 1564, 1565, 1566, 1567, 1568, 1569, 1903, 1904, 1905, 1910,
  // slope-corner solids (OpenGD _pSolids)
  296, 297, 374,
];

/** Solid rects that are not the plain grid footprint. Ids absent here use
 *  gridW×gridH blocks from the bootstrap (30×30 for full blocks). [O] */
export const SOLID_SIZES: ReadonlyMap<number, RectSize> = new Map<number, RectSize>([
  // slabs
  [40, { w: 30, h: 14 }],
  [147, { w: 30, h: 14 }],
  [1903, { w: 30, h: 14 }],
  [1904, { w: 30, h: 14 }],
  [1905, { w: 30, h: 14 }],
  [62, { w: 30, h: 16 }],
  [65, { w: 30, h: 16 }],
  [66, { w: 30, h: 16 }],
  [68, { w: 30, h: 16 }],
  // quarter blocks
  [64, { w: 15, h: 15 }],
  [195, { w: 15, h: 15 }],
  [206, { w: 15, h: 15 }],
  [1910, { w: 15, h: 15 }],
  [196, { w: 15, h: 8 }],
  [204, { w: 15, h: 8 }],
  [1202, { w: 30, h: 3 }],
  [1220, { w: 30, h: 6 }],
  [1340, { w: 27, h: 2 }],
  [1343, { w: 25, h: 3 }],
  // metal-slab slope connectors
  [328, { w: 22, h: 22 }],
  [329, { w: 43, h: 22 }],
]);

/** The port's "soliddeco" ids: block-looking sprites that are Decoration in the game. */
/** Filler and detail blocks with no hitbox: the fifth piece of each 1.x block set (5, 73, 80,
 *  120, 193, …). For ids ≤ 1911 the game table in gdcloneHitboxes.ts decides anyway; this
 *  list matters for the bootstrap fallback only. */
export const SOLID_DECO_IDS: readonly number[] = [5, 73, 80, 120, 193, 211, 233, 251, 259, 266, 273, 279, 280, 281, 282];

// ---------------------------------------------------------------------------
// Slopes — GameObjectType 25, 72 ids; every one is 45° 1×1 or 22.5° 2×1 [O][P]
// ---------------------------------------------------------------------------

export const SLOPE_45_IDS: readonly number[] = [
  289, 294, 299, 305, 309, 315, 321, 326, 331, 337, 343, 349, 353, 363, 366, 371, 483, 492, 651, 665, 673, 709, 711, 726,
  728, 886, 1338, 1341, 1344, 1717, 1723, 1743, 1745, 1747, 1749, 1906,
];

export const SLOPE_22_IDS: readonly number[] = [
  291, 295, 301, 307, 311, 317, 323, 327, 333, 339, 345, 351, 355, 364, 367, 372, 484, 493, 652, 666, 674, 710, 712, 727,
  729, 887, 1339, 1342, 1345, 1718, 1724, 1744, 1746, 1748, 1750, 1907,
];

// ---------------------------------------------------------------------------
// Hazards — GameObjectType 2 (+ 2.2 damage objects and animated hazards)
// ---------------------------------------------------------------------------

/** Rect spikes and pit pieces. OpenGD stores the rect's bottom-left relative to
 *  the centre; converted here to a centre offset. Most are centred; the wide
 *  "edge" pieces sit off-centre because the sprite's hazard part does. [O] */
export const HAZARD_RECTS: ReadonlyMap<number, RectWithOffset> = (() => {
  const m = new Map<number, RectWithOffset>();
  const set = (ids: readonly number[], w: number, h: number, ox = 0, oy = 0): void => {
    for (const id of ids) m.set(id, { w, h, ox, oy });
  };
  set([8, 144, 216, 177], 6, 12); // full spike (invisible / coloured / ice variants)
  set([39, 205, 217], 6, 5.6); // half spike
  set([178], 6, 6.4); // half ice spike
  set([103, 145, 218], 4, 7.6); // small spike
  set([179], 4, 8); // small ice spike
  set([392, 458, 459], 2.6, 4.8); // tiny spike
  set([9, 1715], 9, 10.8); // spike black pit
  set([61, 1719], 9, 7.2); // wavy black pit
  set([135, 1711], 14.1, 20); // thorn pit 1
  set([1712], 13.5, 22.4);
  set([1713], 11.7, 20);
  set([1714], 11.4, 16.4);
  set([365, 1716], 9, 6); // spike black (low)
  set([368, 1722], 9, 4); // wavy black (low)
  set([421, 1725], 9, 5.2); // wide spike black
  set([422, 1726], 6, 4.4, -5, 0); // wide spike edge: rect bottom-left at (−8,−2.2) → centre −5
  set([768, 1727], 4.5, 5.2); // wide spike half
  set([446, 1728], 9, 7.2); // round black
  set([447, 1729], 5.2, 7.2, -5, 0); // round black edge: bottom-left (−7.6,−3.6) → centre −5
  set([667, 1730], 9, 6); // square black
  set([720, 1731, 991, 1733], 2.4, 3.2); // square black edge / slope corner
  set([989, 1732], 9, 12); // square black slope hazard
  set([243, 1720], 6, 7.2, -5, 0); // wavy pit right edge: bottom-left (−8,−3.6) → centre −5
  set([244, 1721], 6, 6.8, 5, 0); // wavy pit left edge: bottom-left (+2,−3.4) → centre +5
  // 2.2 damage square: a full block that kills [P]
  set([3610], 30, 30);
  // 919 black sludge: 30×10 sprite [S]; the goo is a thin strip in the sprite's lower half.
  set([919], 25, 5);
  return m;
})();

/** Circular hazards, OpenGD radii (canonical where the port disagrees, e.g. 98). [O] */
export const HAZARD_CIRCLES: ReadonlyMap<number, number> = new Map<number, number>([
  [88, 32.3],
  [1705, 32.3],
  [89, 21.6],
  [1706, 21.6],
  [98, 12],
  [1707, 12],
  [186, 32.3],
  [740, 32.3],
  [187, 21.96],
  [741, 21.96],
  [188, 12.6],
  [742, 12.6],
  [183, 15.48],
  [184, 20.4],
  [185, 3],
  [397, 28.9],
  [1708, 28.9],
  [398, 17.6],
  [1709, 17.6],
  [399, 12.9],
  [1710, 12.9],
  [675, 32],
  [1734, 32],
  [676, 17.68],
  [1735, 17.68],
  [677, 12.48],
  [1736, 12.48],
  [678, 30.4],
  [679, 18.72],
  [680, 10.8],
  [1619, 25],
  [1620, 15],
  // blade traps and fireballs: OpenGD gives both a bounding rect and a small radius; the radius is the kill shape
  [1701, 6],
  [1702, 6],
  [1703, 6],
  [1582, 4],
  [1583, 4],
  // 2.2 damage circle [P]
  [3611, 15],
]);

/** Skeletal monsters. Radii are guesses around the body: 918 is the port's 24;
 *  the others are ~40 % of the body sprite (30×25, 30×36, 32×25 units [S]),
 *  2012 the port's 15. Marked manual so they show up in the eyeball list. */
export const ANIMATED_HAZARDS: ReadonlyMap<number, number> = new Map<number, number>([
  [918, 24],
  [1327, 12],
  [1328, 14],
  [1584, 12],
  [2012, 15],
]);

/**
 * A round hazard's own box, w×h before scale: +648/+652, which only a
 * trigger's turn makes it meet the player with (ObjectSet.turned). A sprite
 * object takes its frame's untrimmed size, spriteSourceSize / 4 in the uhd
 * sheets; the bootstrap's grid sizes follow the trimmed rect instead, about
 * half as wide for the big blades. 1583 takes its animation's frames
 * (fireball_02_00N). The skeletal monsters set their own in
 * setupAnimatedSize, whatever their sprite: 918 is 48 across, the rest 8.
 * Anything round not listed falls back on the bootstrap's grid size.
 * [S; GameObject::commonSetup, gd-ida-decomp.cpp:166725-166726;
 *  AnimatedGameObject::setupAnimatedSize :307266-307340]
 */
export const ROUND_HAZARD_BOXES: ReadonlyMap<number, RectSize> = (() => {
  const m = new Map<number, RectSize>();
  const set = (ids: number[], w: number, h: number): void => {
    for (const id of ids) m.set(id, { w, h });
  };
  set([88, 1705], 83.5, 82); // sawblade_01_001
  set([89, 1706], 60, 60); // sawblade_02_001
  set([98], 39.75, 39.5); // sawblade_03_001
  set([186, 740], 84, 84.5); // blade_01_001
  set([187, 741], 60.75, 60.5); // blade_02_001
  set([188, 742], 42, 42); // blade_03_001
  set([183], 84.5, 85); // blade_b_01_001
  set([184], 60, 69); // blade_b_02_001
  set([185], 9.5, 40); // blade_b_03_001
  set([397, 1708], 84.5, 85); // darkblade_01_001
  set([398, 1709], 54.5, 63); // darkblade_02_001
  set([399, 1710], 43, 43); // darkblade_03_001
  set([675], 77, 77.5); // blackCogwheel_01_color_001
  set([1734], 80, 80); // blackCogwheel_01_001
  set([676], 49, 49.5); // blackCogwheel_02_color_001
  set([1735], 51.5, 52.5); // blackCogwheel_02_001
  set([677], 36, 36); // blackCogwheel_03_color_001
  set([1736], 39, 39); // blackCogwheel_03_001
  set([678], 79, 79.5); // lightBlade_01_001
  set([679], 51.5, 54.5); // lightBlade_02_001
  set([680], 36, 36); // lightBlade_03_001
  set([1619], 73.5, 76); // spinBlade01_001
  set([1620], 49, 50); // spinBlade02_001
  set([1701], 39, 28); // bladeTrap01_001
  set([1702], 28.5, 28.5); // bladeTrap02_001
  set([1703], 24.5, 24.5); // bladeTrap03_001
  set([1582], 25.5, 25); // fireball_01_001
  set([1583], 69.5, 22.5); // fireball_02_001..004
  set([918], 48, 48);
  set([1327, 1584, 2012], 8, 8);
  set([1328], 8, 15);
  return m;
})();

/** Sprites that look like spikes but are Decoration in the game. [O] */
export const FAKE_SPIKE_IDS: readonly number[] = [191, 198, 199, 393, 1889, 1890, 1891, 1892];
