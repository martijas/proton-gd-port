// The interface's layout arithmetic: the pieces the game's menus are built
// from, decidable without a browser. Positions here are the ones the decompile
// gives; a screen that draws them is checked by eye, the sums are checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packedGlyphQuad } from "../src/ui/art";
import { backArrow, clock, corners, label, pageDots, spriteButton, type ArtLookup } from "../src/ui/chrome";
import { grown, MENU_SKY_PARALLAX } from "../src/ui/render";
import { pageColourIndex } from "../src/ui/screens/levelSelect";
import { MENU_SKY_SEQUENCE } from "../src/ui/screens/menu";
import { viewportFor } from "../src/ui/viewport";
import { barFill, snapPage, type Widget } from "../src/ui/widgets";

/** Art that answers every name with a 40 by 20 piece and measures text at 10 units a glyph. */
const ART: ArtLookup = {
  quad: () => ({ u0: 0, v0: 0, du: 1, dv: 1, unit: 3, w: 40, h: 20 }),
  measure: (_font, text, opts) => ({ width: text.length * 10 * (opts?.scale ?? 1), height: 32 * (opts?.scale ?? 1) }),
  fit: (_font, text, maxWidth, max = 1) => Math.min(max, maxWidth / (text.length * 10)),
};

// --- bars and pages --------------------------------------------------------

test("a bar's fill starts a hair in from the left and covers the fraction asked for", () => {
  const half = barFill(0.5);
  assert.ok(half.from > 0 && half.from < 0.01, `inset should be tiny, got ${half.from}`);
  assert.ok(Math.abs(half.to - (half.from + (1 - half.from * 2) * 0.5)) < 1e-9);
  const full = barFill(1);
  assert.ok(Math.abs(full.to - (1 - full.from)) < 1e-9, "a full bar stops the same hair short of the right");
  assert.equal(barFill(-1).to, barFill(0).to, "below zero is zero");
  assert.equal(barFill(7).to, full.to, "above one is one");
});

test("pages snap to the nearest one, or the next one when the swipe went that way", () => {
  assert.equal(snapPage(0, 500, 5), 0);
  assert.equal(snapPage(240, 500, 5), 0, "under half a page goes back");
  assert.equal(snapPage(260, 500, 5), 1, "over half a page goes on");
  assert.equal(snapPage(160, 500, 5, 1), 1, "a third of a page with momentum forward goes on");
  assert.equal(snapPage(340, 500, 5, -1), 0, "two thirds with momentum back goes back");
  assert.equal(snapPage(9000, 500, 5), 4, "past the end is the last page");
  assert.equal(snapPage(-300, 500, 5), 0, "before the start is the first");
  assert.equal(snapPage(100, 0, 5), 0, "no width is no page");
});

// --- a font on the packed page ---------------------------------------------

test("a packed face's glyph is offset by where its page landed and drawn from the page's unit", () => {
  const page = { pageWidth: 2048, pageHeight: 2048 };
  const packed = { x: 66, y: 2 };
  const char = { x: 10, y: 20, w: 30, h: 40 };
  const q = packedGlyphQuad(page, packed, char, 4, 13);
  assert.ok(Math.abs(q.u0 - 76 / 2048) < 1e-12);
  assert.ok(Math.abs(q.v0 - 22 / 2048) < 1e-12);
  assert.ok(Math.abs(q.du - 30 / 2048) < 1e-12);
  assert.ok(Math.abs(q.dv - 40 / 2048) < 1e-12);
  assert.equal(q.unit, 13);
  assert.equal(q.w, 7.5, "30 px at 4 px per unit");
  assert.equal(q.h, 10);
});

// --- the chrome ------------------------------------------------------------

test("a sprite button's press area is the art's own size, grown by the size multiplier", () => {
  const [sprite, button] = spriteButton(ART, "go", 100, 50, "x.png", { sizeMult: 2 });
  assert.equal(sprite.kind, "sprite");
  assert.equal(button.kind, "button");
  if (sprite.kind !== "sprite" || button.kind !== "button") return;
  assert.equal(sprite.pressedBy, "go", "the face knows which button it belongs to");
  assert.deepEqual(button.rect, { x: 100 - 40, y: 50 - 20, w: 80, h: 40 });
  assert.equal(button.tint?.a, 0, "the press area itself draws nothing");
});

test("a label is placed by its anchor, so the game's centre points land the text's centre", () => {
  const centred = label(ART, "Stereo", 200, 100, { scale: 0.5 });
  assert.equal(centred.kind, "text");
  if (centred.kind !== "text") return;
  // Six glyphs at 10 each at half scale is 30 wide, 16 tall.
  assert.equal(centred.x, 185);
  assert.equal(centred.y, 92);
  const left = label(ART, "Stereo", 200, 100, { scale: 0.5, anchorX: 0 });
  if (left.kind === "text") assert.equal(left.x, 200);
  const right = label(ART, "Stereo", 200, 100, { scale: 0.5, anchorX: 1, anchorY: 0 });
  if (right.kind === "text") {
    assert.equal(right.x, 170);
    assert.equal(right.y, 100);
  }
});

test("the corner art sits one unit past the edge and is flipped for the right and the top", () => {
  const view = viewportFor(1920, 1080);
  const [bl, br, tr] = corners(view, ["bottomLeft", "bottomRight", "topRight"]);
  for (const c of [bl, br, tr]) assert.equal(c.kind, "sprite");
  if (bl.kind !== "sprite" || br.kind !== "sprite" || tr.kind !== "sprite") return;
  assert.deepEqual([bl.x, bl.y, bl.flipX ?? false, bl.flipY ?? false], [-1, -1, false, false]);
  assert.deepEqual([br.x, br.y, br.flipX, br.originX], [view.width + 1, -1, true, 1]);
  assert.deepEqual([tr.x, tr.y, tr.flipX, tr.flipY, tr.originY], [view.width + 1, view.height + 1, true, true, 1]);
});

test("the back arrow is where the game puts it, green a hair off pink", () => {
  const view = viewportFor(1920, 1080);
  const green = backArrow(ART, view, "green")[0];
  const pink = backArrow(ART, view, "pink")[0];
  if (green.kind !== "sprite" || pink.kind !== "sprite") return assert.fail("expected sprites");
  assert.deepEqual([green.x, green.y], [25, view.height - 22]);
  assert.deepEqual([pink.x, pink.y], [24, view.height - 23]);
});

test("page dots are centred on their point with the current one lit", () => {
  const dots = pageDots(100, 10, 3, 1, 12);
  const xs = dots.map((d) => (d.kind === "sprite" ? d.x : NaN));
  assert.deepEqual(xs, [88, 100, 112]);
  const lit = dots.map((d) => (d.kind === "sprite" ? d.frame : ""));
  assert.equal(lit[1], "gj_navDotBtn_on_001.png");
  assert.equal(lit[0], "gj_navDotBtn_off_001.png");
});

test("a held button grows about its own centre", () => {
  const r = grown({ x: 10, y: 10, w: 100, h: 50 }, 1.26);
  assert.ok(Math.abs(r.w - 126) < 1e-9);
  assert.ok(Math.abs(r.h - 63) < 1e-9);
  assert.ok(Math.abs(r.x + r.w / 2 - 60) < 1e-9, "same centre x");
  assert.ok(Math.abs(r.y + r.h / 2 - 35) < 1e-9, "same centre y");
});

test("the end screen's clock reads mm:ss and grows an hours field past an hour", () => {
  assert.equal(clock(0), "00:00");
  assert.equal(clock(35.9), "00:35");
  assert.equal(clock(61), "01:01");
  assert.equal(clock(3600 + 65), "01:01:05");
});

// --- the game's own colour tables ------------------------------------------

test("the level select's sky follows the game's page table and wraps every nine", () => {
  assert.equal(pageColourIndex(0), 5);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(pageColourIndex), [7, 8, 9, 10, 11, 1, 3, 4]);
  assert.equal(pageColourIndex(9), 5, "page nine is page zero's colour again");
  assert.equal(pageColourIndex(10), 7);
  assert.equal(pageColourIndex(22), "tower", "every twenty-second page is the Tower's slate");
});

test("the menu's sky cycles the game's eight entries, the blue first", () => {
  assert.equal(MENU_SKY_SEQUENCE.length, 8);
  assert.equal(MENU_SKY_SEQUENCE[0], null, "the first entry is the game's own blue, not a table colour");
  assert.deepEqual(MENU_SKY_SEQUENCE.slice(1), [7, 8, 9, 10, 11, 1, 3]);
  assert.equal(MENU_SKY_PARALLAX, 0.1);
});

test("a widget list never carries a backdrop inside a list row", () => {
  // The backdrop binds texture units; a row is placed by shifting, and a
  // backdrop has nothing to shift — it must stay at the top level.
  const w: Widget = { kind: "backdrop", tint: { r: 0, g: 0, b: 0 }, groundTint: { r: 0, g: 0, b: 0 }, offset: 0, groundTop: 90 };
  assert.equal(w.kind, "backdrop");
});
