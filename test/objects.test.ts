import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildObjectTable, canRotateFree, gameObjectType, loadAngles, type BootstrapJson } from "../src/physics/objects";
import { LEGACY_TRIGGER_IDS, SLOPE_22_IDS, SLOPE_45_IDS } from "../src/physics/objectData";
import type { Hitbox, ObjectDef, ObjectKind } from "../src/physics/types";
import { PROJECT_ROOT as ROOT } from "../tools/paths";

interface Census {
  counts: Record<string, number>;
  perLevel: Record<string, number[]>;
}

const bootstrap = JSON.parse(readFileSync(`${ROOT}/data/objects-bootstrap.json`, "utf8")) as BootstrapJson;
const census = JSON.parse(readFileSync(`${ROOT}/data/census.json`, "utf8")) as Census;
const table = buildObjectTable(bootstrap);

const censusIds = Object.keys(census.counts)
  .map(Number)
  .sort((a, b) => a - b);

/** Kinds whose objects the sim must be able to collide with. */
const COLLIDABLE: ReadonlySet<ObjectKind> = new Set(["solid", "hazard", "slope", "orb", "pad", "portal", "collectible"]);

function fmt(h: Hitbox): string {
  if (!h) return "null";
  if (h.type === "circle") return `circle r=${h.r}`;
  if (h.type === "slope") return `slope ${h.w}x${h.h}`;
  return `box ${h.w}x${h.h}${h.ox || h.oy ? ` @(${h.ox},${h.oy})` : ""}`;
}

test("every id used by the official levels resolves to a known kind", () => {
  const unknown = censusIds.filter((id) => table.get(id).kind === "unknown");
  console.log(`unknown ids used by official levels: [${unknown.join(", ")}]`);
  const stray = unknown.filter((id) => !LEGACY_TRIGGER_IDS.includes(id));
  assert.deepEqual(stray, [], `unclassified official-level ids: ${stray.join(", ")}`);
  // 717, 718 and 743 are missing from the bootstrap but objectData maps them by hand.
  for (const id of LEGACY_TRIGGER_IDS) assert.equal(table.get(id).kind, "trigger", `legacy colour trigger ${id}`);
  assert.deepEqual(unknown, []);
  for (const id of censusIds) assert.ok(table.has(id), `table lacks ${id}`);
});

test("every collidable object in the official levels has a hitbox", () => {
  const missing: string[] = [];
  for (const id of censusIds) {
    const d = table.get(id);
    if (COLLIDABLE.has(d.kind) && d.hitbox === null) missing.push(`${id} (${d.kind})`);
  }
  assert.deepEqual(missing, [], `collidable ids without a hitbox: ${missing.join(", ")}`);
});

test("slopes are exactly the 72 collidable ids, 45° 1x1 or 22.5° 2x1", () => {
  assert.equal(SLOPE_45_IDS.length, 36);
  assert.equal(SLOPE_22_IDS.length, 36);
  const slopes = table.ids().filter((id) => table.get(id).kind === "slope");
  for (const id of [...SLOPE_45_IDS, ...SLOPE_22_IDS]) assert.ok(slopes.includes(id), `slope ${id} missing`);
  assert.equal(slopes.length, 72, `slope count ${slopes.length}`);
  // customSetup types the perspective slopes 522/523 as Slope, but
  // setupCustomSprites runs after it and makes them Decoration: no hitbox.
  // [GameObject::setupCustomSprites LABEL_1827 :613575-613582; objectFromVector :184192-184201]
  for (const id of [522, 523]) {
    assert.equal(table.get(id).kind, "decoration", `perspective slope ${id}`);
    assert.equal(table.get(id).hitbox, null, `perspective slope ${id}`);
  }
  for (const id of SLOPE_45_IDS) assert.deepEqual(table.get(id).hitbox, { type: "slope", w: 30, h: 30 }, `slope ${id}`);
  for (const id of SLOPE_22_IDS) assert.deepEqual(table.get(id).hitbox, { type: "slope", w: 60, h: 30 }, `slope ${id}`);
});

test("get never throws and unknown ids come back as 'unknown'", () => {
  const d = table.get(999999);
  assert.equal(d.kind, "unknown");
  assert.equal(d.hitbox, null);
  assert.equal(table.has(999999), false);
  assert.equal(table.get(-1).kind, "unknown");
});

test("definitions carry the sprite footprint the broadphase falls back to", () => {
  const spike = table.get(8);
  assert.equal(spike.gridW, 1);
  assert.equal(spike.gridH, 1);
  const slope = table.get(291);
  assert.equal(slope.gridW, 2);
});

interface Expect {
  kind: ObjectKind;
  hitbox?: Hitbox;
  extra?: Partial<ObjectDef>;
}

const boxOf = (w: number, h: number, ox = 0, oy = 0): Hitbox => ({ type: "box", w, h, ox, oy });

const SPOT_CHECKS: Record<number, Expect> = {
  8: { kind: "hazard", hitbox: boxOf(6, 12) },
  88: { kind: "hazard", hitbox: { type: "circle", r: 32.3, ox: 0, oy: 0 } },
  289: { kind: "slope", hitbox: { type: "slope", w: 30, h: 30 } },
  291: { kind: "slope", hitbox: { type: "slope", w: 60, h: 30 } },
  13: { kind: "portal", hitbox: boxOf(34, 86), extra: { portal: { type: "mode", mode: "ship" } } },
  200: { kind: "portal", extra: { portal: { type: "speed", speed: 0 } } },
  1334: { kind: "portal", extra: { portal: { type: "speed", speed: 4 } } },
  36: { kind: "orb", hitbox: boxOf(36, 36), extra: { orb: "yellow" } },
  35: { kind: "pad", extra: { pad: "yellow" } },
  747: { kind: "portal", extra: { portal: { type: "teleport", kind: "linkedEntry" } } },
  1933: { kind: "portal", extra: { portal: { type: "mode", mode: "swing" } } },
  2926: { kind: "portal", extra: { portal: { type: "gravityToggle" } } },
  3004: { kind: "orb", extra: { orb: "spider" } },
  1704: { kind: "orb", extra: { orb: "dash" } },
  1751: { kind: "orb", extra: { orb: "dashGravity" } },
  143: { kind: "solid", extra: { breakable: true } },
  1859: { kind: "solid", extra: { special: "H" } },
  1: { kind: "solid", hitbox: boxOf(30, 30) },
  40: { kind: "solid", hitbox: boxOf(30, 14) },
  468: { kind: "solid", hitbox: boxOf(30, 1.5) }, // black outline edge: solid per GameObject::customSetup
  142: { kind: "collectible", extra: { collectible: "secretCoin" } },
  1329: { kind: "collectible", extra: { collectible: "userCoin" } },
  2063: { kind: "checkpoint" },
  3600: { kind: "trigger" }, // an effect object, fired like any trigger [gd_2206_customSetup_objectTypes.csv:3601, type 20]
  31: { kind: "startPos" },
  1816: { kind: "collision" },
  2069: { kind: "forceBlock", extra: { forceShape: "box" } },
  // a few extras beyond the required list
  422: { kind: "hazard", hitbox: boxOf(6, 4.4, -5, 0) },
  3611: { kind: "hazard", hitbox: { type: "circle", r: 15, ox: 0, oy: 0 } },
  3610: { kind: "hazard", hitbox: boxOf(30, 30) },
  191: { kind: "decoration", hitbox: null },
  5: { kind: "decoration", hitbox: null }, // square_05 filler: no hitbox
  647: { kind: "decoration", hitbox: null }, // block003 fill piece: no hitbox in the game table
  507: { kind: "decoration", hitbox: null }, // top-colour strip
  3645: { kind: "forceBlock", extra: { forceShape: "circle" } },
  3643: { kind: "orb", hitbox: boxOf(30, 30), extra: { orb: "toggle" } }, // a 30 × 30 custom ring [GameObject::customSetup :178493-178499]
  918: { kind: "hazard", extra: { animated: true } },
  4404: { kind: "collectible", extra: { collectible: "key" } },
};

test("spot checks", () => {
  for (const [key, exp] of Object.entries(SPOT_CHECKS)) {
    const id = Number(key);
    const d = table.get(id);
    assert.equal(d.kind, exp.kind, `${id} kind: got ${d.kind}, want ${exp.kind}`);
    if (exp.hitbox !== undefined) assert.deepEqual(d.hitbox, exp.hitbox, `${id} hitbox: got ${fmt(d.hitbox)}, want ${fmt(exp.hitbox)}`);
    if (exp.extra) {
      for (const [k, v] of Object.entries(exp.extra)) {
        assert.deepEqual((d as unknown as Record<string, unknown>)[k], v, `${id}.${k}`);
      }
    }
  }
});

test("report", () => {
  const byKind = new Map<ObjectKind, number>();
  const usedByKind = new Map<ObjectKind, number>();
  for (const id of table.ids()) {
    const k = table.get(id).kind;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  for (const id of censusIds) {
    const k = table.get(id).kind;
    usedByKind.set(k, (usedByKind.get(k) ?? 0) + 1);
  }
  console.log("\nobject table: counts by kind (all ids / used by official levels)");
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${String(n).padStart(5)}   ${String(usedByKind.get(k) ?? 0).padStart(5)}`);
  }

  const derived = censusIds
    .map((id) => table.get(id))
    .filter((d) => d.source === "derived" && d.kind !== "unknown");
  console.log(`\nofficial-level ids whose hitbox is a derived guess (${derived.length}) — eyeball these:`);
  for (const d of derived) console.log(`  ${d.id} ${d.kind} ${fmt(d.hitbox)} uses=${census.counts[String(d.id)]}`);

  const manualGuess = censusIds.map((id) => table.get(id)).filter((d) => d.animated);
  console.log(`\nanimated hazards with hand-picked radii (${manualGuess.length}):`);
  for (const d of manualGuess) console.log(`  ${d.id} ${fmt(d.hitbox)} uses=${census.counts[String(d.id)]}`);
  assert.ok((byKind.get("slope") ?? 0) >= 72);
});

// --- the type and angles an object is loaded with ----------------------------

test("an animated object's type is the one EnhancedGameObject gives it", () => {
  // Types that GameObject::customSetup leaves alone come from
  // EnhancedGameObject::customSetup, else the default Solid.
  // [gd-ida-decomp.cpp:181863-182790; GameObject::GameObject :165575]
  assert.equal(gameObjectType(85), 7, "a cogwheel is decoration");
  assert.equal(gameObjectType(1736), 2, "a saw is a hazard");
  assert.equal(gameObjectType(8), 2, "customSetup's own type wins");
  assert.equal(canRotateFree(1, {}), false);
  assert.equal(canRotateFree(1, { 121: "1" }), true);
  assert.equal(canRotateFree(85, {}), true);
});

test("a subclass's own type wins over both customSetups", () => {
  // [EffectGameObject::customSetup :302347-302349 (142), :302424-302425
  //  (1329); ParticleGameObject::customSetup :298440; EnterEffectObject::init
  //  :307736 for the area triggers]
  assert.equal(gameObjectType(142), 22, "a secret coin");
  assert.equal(gameObjectType(1329), 31, "a user coin");
  assert.equal(gameObjectType(2065), 7, "Custom Particles");
  assert.equal(gameObjectType(3006), 45, "an area trigger");
  assert.equal(canRotateFree(142, {}), true);
  const coin = { id: 142, rotation: 45, props: { 131: "30", 132: "60" } } as unknown as Parameters<typeof loadAngles>[0];
  assert.deepEqual(loadAngles(coin), { x: 30, y: 60 }, "a coin keeps its warp");
  assert.deepEqual(loadAngles({ ...coin, props: {} }), { x: 45, y: 45 }, "and an angle off the quarter turns");
});

test("an object's angles: a warp on a free object, a quarter-turn rule on the rest", async () => {
  // [GameObject::objectFromVector :184214-184237]
  const o = (id: number, props: Record<number, string>, rotation = 0) =>
    ({ id, rotation, props }) as unknown as Parameters<typeof loadAngles>[0];
  assert.deepEqual(loadAngles(o(8, { 131: "180", 132: "-180" })), { x: 180, y: -180 }, "The Secret Hollow's upturned spikes");
  assert.deepEqual(loadAngles(o(1, { 131: "30", 132: "60" }, 45)), { x: 0, y: 0 }, "Solid: no warp, and 45° is cut");
  assert.deepEqual(loadAngles(o(1, {}, 90.5)), { x: 90.5, y: 90.5 }, "cut to an integer first, so 90.5 stays");
  assert.deepEqual(loadAngles(o(1, { 121: "1", 131: "30", 132: "60" }, 45)), { x: 30, y: 60 });
  assert.deepEqual(loadAngles(o(508, { 131: "30", 132: "60" }, 45)), { x: 30, y: 60 }, "a 3DL piece is Decoration: warped");
  assert.deepEqual(loadAngles(o(508, {}, 45)), { x: 45, y: 45 }, "and not cut");
  assert.deepEqual(loadAngles(o(85, { 131: "10", 132: "10" }, 20)), { x: 20, y: 20 }, "equal warp angles are no warp");
});

test("setupCustomSprites makes the 3DL pieces and the perspective blocks Decoration", () => {
  // It runs after every customSetup, so its type is the one they keep; 522
  // and 523 are Slope until then. [GameObject::setupCustomSprites
  //  :613324-613375, LABEL_1827 :613575-613582; objectFromVector :184192-184201]
  assert.equal(gameObjectType(508), 7, "a 3DL piece");
  assert.equal(gameObjectType(515), 7, "a perspective block");
  assert.equal(gameObjectType(522), 7, "a perspective slope");
  assert.equal(gameObjectType(902), 7);
  assert.equal(gameObjectType(1560), 7);
  assert.equal(canRotateFree(508, {}), true);
});
