// Hit-testing and the nine-slice arithmetic. Both are pure, and both are the
// kind of thing that looks right on screen while being subtly wrong — a frame
// that overlaps itself by a pixel, a button that steals a click from the row
// above it — so they are checked here rather than by eye.

import { test } from "node:test";
import assert from "node:assert/strict";
import { UiBatch, type UiQuad } from "../src/ui/draw";
import { BLEND } from "../src/engine/gl/spriteBatch";
import { rect } from "../src/ui/viewport";
import { flatten, hitTest, listAt, listMetrics, rowRect, sliderValueAt, type Widget } from "../src/ui/widgets";
import { FRAMES, INSETS } from "../src/ui/art";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { outPath } from "./helpers";

const ASSETS = outPath("assets");
const ART_SKIP = existsSync(join(ASSETS, "ui.json")) ? false : "run `npm run assets` first";

const FLOATS = 12;

function quad(): UiQuad {
  return { u0: 0, v0: 0, du: 1, dv: 1, unit: 0, w: 80, h: 80 };
}

function list(over: Partial<Extract<Widget, { kind: "list" }>> = {}): Extract<Widget, { kind: "list" }> {
  return { kind: "list", id: "l", rect: rect(0, 0, 300, 200), rowSize: 50, scroll: 0, rows: [[], [], []], ...over };
}

test("a click finds the topmost widget under it", () => {
  const panel: Widget = { kind: "panel", rect: rect(0, 0, 200, 100) };
  const under: Widget = { kind: "button", id: "under", rect: rect(10, 10, 80, 30) };
  const over: Widget = { kind: "button", id: "over", rect: rect(20, 15, 80, 30) };
  // Later in the list means drawn later, so it wins where they overlap.
  assert.equal(hitTest([panel, under, over], 50, 25)?.id, "over");
  assert.equal(hitTest([panel, under, over], 12, 12)?.id, "under");
  assert.equal(hitTest([panel, under, over], 190, 90), null, "a panel is not pressable");
});

test("a disabled button is not pressable and does not shadow what is under it", () => {
  const under: Widget = { kind: "button", id: "under", rect: rect(0, 0, 100, 100) };
  const off: Widget = { kind: "button", id: "off", rect: rect(0, 0, 100, 100), enabled: false };
  assert.equal(hitTest([under, off], 50, 50)?.id, "under");
});

test("a row's button is found before the list it sits in", () => {
  const rows: Widget[][] = [
    [{ kind: "button", id: "row0", rect: rect(10, 10, 100, 30) }],
    [{ kind: "button", id: "row1", rect: rect(10, 10, 100, 30) }],
  ];
  const l = list({ id: "levels", rows });
  // Row 0 is at the top of a vertical list, y 150..200, so its button is 160..190.
  assert.equal(hitTest([l], 50, 175)?.id, "row0");
  assert.equal(hitTest([l], 50, 125)?.id, "row1");
  // Away from any row's button the drag lands on the list itself.
  assert.equal(hitTest([l], 250, 100)?.id, "levels");
});

test("a vertical list runs downward and a horizontal one rightward", () => {
  const first = rowRect(list(), 0);
  const second = rowRect(list(), 1);
  assert.ok(first.y > second.y, "row 0 should sit above row 1");
  assert.equal(rowRect(list({ horizontal: true }), 1).x, 50, "a horizontal list moves right");
});

test("a list that fits cannot be scrolled, and one that does not has a limit", () => {
  assert.equal(listMetrics(list({ rows: [[], []] })).maxScroll, 0);
  assert.equal(listMetrics(list({ rows: [[], [], [], [], [], []] })).maxScroll, 100, "6 rows of 50 in 200 leaves 100");
});

test("only the rows on screen are flattened", () => {
  const rows: Widget[][] = [];
  for (let i = 0; i < 100; i++) rows.push([{ kind: "button", id: `r${i}`, rect: rect(0, 0, 100, 40) }]);
  const flat = flatten([list({ rows })]);
  assert.ok(flat.length < 10, `${flat.length} widgets flattened from 100 rows`);
});

test("scrolling a list moves which rows are on screen", () => {
  const rows: Widget[][] = [];
  for (let i = 0; i < 20; i++) rows.push([{ kind: "button", id: `r${i}`, rect: rect(0, 0, 100, 40) }]);
  const top = listMetrics(list({ rows }));
  const down = listMetrics(list({ rows, scroll: 500 }));
  assert.equal(top.firstVisible, 0);
  assert.equal(down.firstVisible, 10);
});

test("a slider reads a fraction of its own width, clamped", () => {
  const s = { kind: "slider", id: "music", rect: rect(100, 0, 200, 20), value: 0 } as const;
  assert.equal(sliderValueAt(s, 100), 0);
  assert.equal(sliderValueAt(s, 200), 0.5);
  assert.equal(sliderValueAt(s, 300), 1);
  assert.equal(sliderValueAt(s, 0), 0, "left of the track is 0, not negative");
  assert.equal(sliderValueAt(s, 9999), 1);
});

test("a nine-slice covers exactly the rectangle asked for, in nine pieces", () => {
  const batch = new UiBatch();
  batch.begin();
  const box = rect(10, 20, 300, 160);
  batch.nineSlice(quad(), box, { left: 20, right: 20, top: 20, bottom: 20 });
  assert.equal(batch.count, 9);

  const data = batch.buffer;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let area = 0;
  for (let i = 0; i < batch.count; i++) {
    const f = i * FLOATS;
    const hw = data[f];
    const hh = data[f + 3];
    const cx = data[f + 4];
    const cy = data[f + 5];
    minX = Math.min(minX, cx - hw);
    maxX = Math.max(maxX, cx + hw);
    minY = Math.min(minY, cy - hh);
    maxY = Math.max(maxY, cy + hh);
    area += hw * 2 * hh * 2;
  }
  assert.ok(Math.abs(minX - box.x) < 1e-6, `left edge ${minX}`);
  assert.ok(Math.abs(maxX - (box.x + box.w)) < 1e-6, `right edge ${maxX}`);
  assert.ok(Math.abs(minY - box.y) < 1e-6, `bottom edge ${minY}`);
  assert.ok(Math.abs(maxY - (box.y + box.h)) < 1e-6, `top edge ${maxY}`);
  // No gap and no overlap: the nine pieces tile the box exactly.
  assert.ok(Math.abs(area - box.w * box.h) < 1e-6, `the pieces cover ${area}, not ${box.w * box.h}`);
});

test("a nine-slice narrower than its own corners shrinks them instead of folding", () => {
  const batch = new UiBatch();
  batch.begin();
  const box = rect(0, 0, 30, 100);
  batch.nineSlice(quad(), box, { left: 20, right: 20, top: 10, bottom: 10 });
  // Every piece has to stay inside the box. Left alone, the two 20-unit corners
  // overlap backwards in a 30-unit box and draw a knot of border outside it.
  const d = batch.buffer;
  for (let i = 0; i < batch.count; i++) {
    const f = i * FLOATS;
    assert.ok(d[f] > 0, "no piece may have negative width");
    assert.ok(d[f + 4] - d[f] >= box.x - 1e-6, "and none may start left of the box");
    assert.ok(d[f + 4] + d[f] <= box.x + box.w + 1e-6, "or end right of it");
  }
});

test("a nine-slice with no width at all draws nothing", () => {
  // A progress bar at 0% asks for exactly this every frame.
  const batch = new UiBatch();
  batch.begin();
  batch.nineSlice(quad(), rect(10, 10, 0, 12), { left: 12, right: 12, top: 12, bottom: 12 });
  assert.equal(batch.count, 0);
});

test("a sub-quad takes the right part of the texture, with v running the other way", () => {
  const batch = new UiBatch();
  const full: UiQuad = { u0: 0.25, v0: 0.5, du: 0.25, dv: 0.25, unit: 3, w: 100, h: 40 };
  const topLeft = batch.subQuad(full, 0, 0.5, 0.5, 1);
  assert.ok(Math.abs(topLeft.u0 - 0.25) < 1e-9, "u starts at the frame's own left");
  assert.ok(Math.abs(topLeft.du - 0.125) < 1e-9, "and is half as wide");
  // Texture v runs down while design y runs up, so the top half is the first half of v.
  assert.ok(Math.abs(topLeft.v0 - 0.5) < 1e-9, `v0 ${topLeft.v0}`);
  assert.ok(Math.abs(topLeft.dv - 0.125) < 1e-9);
  assert.equal(topLeft.unit, 3, "it stays on the same texture");
  assert.ok(Math.abs(topLeft.w - 50) < 1e-9);

  const bottomLeft = batch.subQuad(full, 0, 0, 0.5, 0.5);
  assert.ok(bottomLeft.v0 > topLeft.v0, "the bottom piece is further down the texture");
});

test("an additive sprite keeps its alpha and adds as the game's additive sprites do", () => {
  // GL_SRC_ALPHA / GL_ONE on premultiplied art, as the ground layer's line
  // is set when it is made. [GJGroundLayer::createLine :382015-382055]
  const batch = new UiBatch();
  batch.begin();
  batch.sprite(quad(), 0, 0, { tint: { r: 255, g: 128, b: 0, additive: true } });
  const bytes = new Uint8Array(batch.buffer.buffer);
  // The shader multiplies the colour by this alpha, so zero here would add
  // nothing at all; the flag is what zeroes the output alpha.
  assert.equal(bytes[43], 255, "the colour keeps its strength");
  assert.equal(bytes[46], BLEND.ADD_SPRITE, "and the additive flag is set");
});

test("fading a sprite fades its alpha, and the shader dims its tint by it once", () => {
  // cocos multiplies a sprite's colour by its opacity once (opacityModifyRGB);
  // the shader does that from the alpha byte, so the colour goes in as it is.
  // [CCSprite::updateColor :863976-864005]
  const batch = new UiBatch();
  batch.begin();
  batch.sprite(quad(), 0, 0, { tint: { r: 200, g: 100, b: 50 }, alpha: 0.5 });
  const bytes = new Uint8Array(batch.buffer.buffer);
  assert.deepEqual([...bytes.slice(40, 44)], [200, 100, 50, 128]);
  assert.equal(bytes[46], BLEND.NORMAL);
});

test("an origin moves the sprite without changing its size", () => {
  const batch = new UiBatch();
  batch.begin();
  batch.sprite(quad(), 0, 0, { originX: 0, originY: 0 });
  const d = batch.buffer;
  assert.ok(Math.abs(d[4] - 40) < 1e-9, "a bottom-left origin puts the centre half a width right");
  assert.ok(Math.abs(d[5] - 40) < 1e-9);
  assert.ok(Math.abs(d[0] - 40) < 1e-9, "the half-width is unchanged");
});

test("the batch grows rather than dropping sprites", () => {
  const batch = new UiBatch();
  batch.begin();
  for (let i = 0; i < 5000; i++) batch.sprite(quad(), i, 0);
  assert.equal(batch.count, 5000);
  // The last one is readable, so growing copied what was already written.
  assert.ok(Math.abs(batch.buffer[4999 * FLOATS + 4] - 4999) < 1e-6);
});

test("begin resets the batch so a frame does not inherit the last one", () => {
  const batch = new UiBatch();
  batch.begin();
  batch.sprite(quad(), 0, 0);
  batch.begin();
  assert.equal(batch.count, 0);
});

test("every frame the interface names exists in the built art", { skip: ART_SKIP }, () => {
  // A name that resolves to nothing draws nothing and says nothing, so the
  // frame table is checked against the atlas and the packed page rather than
  // discovered on screen.
  const atlas = JSON.parse(readFileSync(join(ASSETS, "atlas/uhd.json"), "utf8")) as { frames: Record<string, unknown> };
  const page = JSON.parse(readFileSync(join(ASSETS, "ui.json"), "utf8")) as { images: Record<string, unknown> };
  const missing = Object.entries(FRAMES).filter(([, name]) => !(name in atlas.frames) && !(name in page.images));
  assert.deepEqual(missing, [], `these frame names resolve to nothing: ${missing.map(([k]) => k).join(", ")}`);
});

test("every frame with a nine-slice inset is one the interface actually stretches", { skip: ART_SKIP }, () => {
  const page = JSON.parse(readFileSync(join(ASSETS, "ui.json"), "utf8")) as { images: Record<string, { w: number; h: number; pxPerUnit: number }> };
  for (const [name, inset] of Object.entries(INSETS)) {
    const art = page.images[name];
    assert.ok(art, `${name} has insets but is not on the interface page`);
    const w = art.w / art.pxPerUnit;
    const h = art.h / art.pxPerUnit;
    // Corners that overlap would smear; the two ends have to fit inside the art.
    assert.ok(inset.left + inset.right < w, `${name}: ${inset.left}+${inset.right} does not fit in ${w}`);
    assert.ok(inset.top + inset.bottom < h, `${name}: ${inset.top}+${inset.bottom} does not fit in ${h}`);
  }
});

test("a point on a row finds the row for a tap and the list for a scroll", () => {
  // These two answers have to differ. A tap on a level row should press the row;
  // a drag from the same point should scroll the list. Returning the row for
  // both is why the level list would not scroll at all.
  const rows: Widget[][] = [[{ kind: "button", id: "row0", rect: rect(10, 10, 100, 30) }]];
  const l = list({ id: "levels", rows });
  assert.equal(hitTest([l], 50, 175)?.id, "row0", "a tap presses the row");
  assert.equal(listAt([l], 50, 175)?.id, "levels", "a drag scrolls the list");
});

test("a point outside every list has no list to scroll", () => {
  const l = list({ id: "levels", rect: rect(0, 0, 100, 100) });
  assert.equal(listAt([l], 500, 500), null);
});

test("listAt looks past a row's own widgets to the list itself", () => {
  // The list is earlier in the array than its rows are once flattened, so a
  // naive back-to-front walk over the flattened list would never reach it.
  const rows: Widget[][] = [[{ kind: "panel", rect: rect(0, 0, 200, 40) }]];
  const l = list({ id: "levels", rows });
  assert.equal(listAt([l], 50, 175)?.id, "levels");
});

test("a list scrolled past its end still shows its last rows", () => {
  // The rows a list shows and where it puts them come from two functions, and
  // they have to agree. They did not: one clamped the scroll and the other did
  // not, so a list pushed past its end picked the right rows and drew them off
  // screen — a blank list.
  const rows: Widget[][] = [];
  for (let i = 0; i < 20; i++) rows.push([{ kind: "button", id: `r${i}`, rect: rect(0, 0, 100, 40) }]);
  const overscrolled = list({ rows, scroll: 99999 });
  const metrics = listMetrics(overscrolled);
  const box = rowRect(overscrolled, metrics.lastVisible);
  assert.ok(box.y + box.h > overscrolled.rect.y, "the last row should still be inside the list");
  assert.ok(flatten([overscrolled]).length > 1, "and something should be drawn");
});

test("a list scrolled to a negative offset stays at the top", () => {
  const rows: Widget[][] = [[], [], [], [], [], []];
  const above = rowRect(list({ rows, scroll: -500 }), 0);
  const atTop = rowRect(list({ rows, scroll: 0 }), 0);
  assert.equal(above.y, atTop.y);
});
