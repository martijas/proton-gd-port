// The icon page packer, on its own: no files, no canvas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packGroups, type PackGroup } from "../tools/assets/pack";

const OPTS = { width: 64, maxHeight: 64, padding: 1 };

function group(id: string, ...sizes: [number, number][]): PackGroup {
  return { id, items: sizes.map(([w, h], i) => ({ key: `${id}#${i}`, w, h })) };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("packs everything without overlapping", () => {
  const sizes = new Map<string, [number, number]>();
  const groups: PackGroup[] = [];
  for (let i = 0; i < 12; i++) {
    const w = 5 + ((i * 7) % 20);
    const h = 4 + ((i * 11) % 18);
    groups.push(group(`g${i}`, [w, h], [Math.ceil(w / 2), Math.ceil(h / 2)]));
    sizes.set(`g${i}#0`, [w, h]);
    sizes.set(`g${i}#1`, [Math.ceil(w / 2), Math.ceil(h / 2)]);
  }
  const out = packGroups(groups, OPTS);
  assert.deepEqual(out.oversized, []);
  assert.equal(out.placements.length, 24);

  const byPage = new Map<number, { x: number; y: number; w: number; h: number }[]>();
  for (const p of out.placements) {
    const size = sizes.get(p.key);
    assert.ok(size, `${p.key} was packed but has no size`);
    const rect = { x: p.x, y: p.y, w: size[0], h: size[1] };
    const page = out.pages[p.page];
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= page.w && rect.y + rect.h <= page.h, `${p.key} falls off page ${p.page}`);
    const list = byPage.get(p.page) ?? [];
    for (const other of list) assert.ok(!overlaps(rect, other), `${p.key} overlaps another frame`);
    list.push(rect);
    byPage.set(p.page, list);
  }
});

test("keeps a group on one page", () => {
  // Three tall items each fill half a page, so the groups must split across
  // pages while each group stays whole.
  const groups = [group("a", [60, 30], [60, 30]), group("b", [60, 30], [60, 30]), group("c", [60, 30], [60, 30])];
  const out = packGroups(groups, OPTS);
  assert.deepEqual(out.oversized, []);
  for (const id of ["a", "b", "c"]) {
    const pages = new Set(out.placements.filter((p) => p.group === id).map((p) => p.page));
    assert.equal(pages.size, 1, `group ${id} was split across pages`);
  }
  assert.ok(out.pages.length >= 3, `expected at least three pages, got ${out.pages.length}`);
});

test("reports a group that cannot fit anywhere", () => {
  const out = packGroups([group("huge", [200, 10])], OPTS);
  assert.deepEqual(out.oversized, ["huge"]);
  assert.equal(out.placements.length, 0);
});

test("leaves a gutter between neighbours", () => {
  const out = packGroups([group("a", [10, 10]), group("b", [10, 10])], { ...OPTS, padding: 2 });
  const [a, b] = out.placements;
  assert.ok(a && b);
  // With padding 2 the second item starts 14 px along, not 10.
  assert.equal(Math.abs(a.x - b.x), 14);
  assert.equal(a.x, 2);
});

test("rounds page height up to a power of two when asked", () => {
  const out = packGroups([group("a", [10, 30])], { ...OPTS, powerOfTwoHeight: true });
  assert.equal(out.pages[0].h, 32);
});
