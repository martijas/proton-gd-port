// The new-best pop-up a death shows, the orbs it pays, and the counter they
// fly to: the arithmetic of what is paid, and the timing of what is shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awardedOrbs, baseOrbs, orbsFor } from "../src/game/orbs";
import { migrate } from "../src/save/store";
import type { ArtLookup } from "../src/ui/chrome";
import { NewBestPopup, OrbReward } from "../src/ui/newBest";
import type { Widget } from "../src/ui/widgets";

const ART: ArtLookup = {
  quad: () => ({ w: 20, h: 20 }) as ReturnType<ArtLookup["quad"]>,
  measure: (_font, text, opts) => ({ width: text.length * 10 * (opts?.scale ?? 1), height: 20 * (opts?.scale ?? 1) }),
};

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function texts(widgets: Widget[]): string[] {
  return widgets.flatMap((w) => (w.kind === "text" ? [w.text] : []));
}

test("an official level's orbs are 20 a star and 20 more, and the three demon finales 400", () => {
  assert.equal(baseOrbs(1, 1, true), 40);
  assert.equal(baseOrbs(6, 6, true), 140);
  assert.equal(baseOrbs(14, 10, true), 400);
  assert.equal(baseOrbs(18, 10, true), 400);
  assert.equal(baseOrbs(20, 10, true), 400);
  assert.equal(baseOrbs(1000, 2, false), 40);
  assert.equal(baseOrbs(1000, 10, false), 400);
  assert.equal(baseOrbs(1000, 1, false), 0, "an auto level pays nothing");
});

test("a death pays for the stretch past the old best, and a completion a quarter more", () => {
  assert.equal(orbsFor(40, 1, 0, 12), 4, "Stereo Madness at 12%: 4.8 rounds down");
  assert.equal(orbsFor(40, 1, 12, 50), 16);
  assert.equal(orbsFor(40, 1, 50, 50), 0, "nothing for matching the best");
  assert.equal(orbsFor(40, 1, 50, 30), 0, "nor for falling short of it");
  assert.equal(orbsFor(40, 0, 0, 50), 0, "an unrated level pays nothing");
  assert.equal(orbsFor(40, 1, 0, 100), 50);
  assert.equal(orbsFor(40, 1, 99, 100), 50 - 39);
  // Paid in pieces or at once, the sum is what the best is worth.
  let paid = 0;
  let best = 0;
  for (const p of [7, 23, 23, 61, 99, 100]) {
    paid += orbsFor(140, 6, best, p);
    best = Math.max(best, p);
  }
  assert.equal(paid, awardedOrbs(140, 100));
});

test("an old save's orb total is counted up later; a kept one survives", () => {
  assert.equal(migrate({ version: 1 }).totals.orbs, -1);
  assert.equal(migrate({ totals: { orbs: 4846 } }).totals.orbs, 4846);
  assert.equal(migrate({ totals: { orbs: "lots" } }).totals.orbs, -1);
});

test("the pop-up grows in, holds 0.7 s, and shrinks away; one that pays holds 1.3 s and darkens the level", () => {
  const plain = new NewBestPopup({ newBest: true, percent: 12, orbs: 0 });
  assert.ok(plain.scale() < 0.05);
  assert.equal(plain.dim(), 0);
  plain.update(0.5);
  assert.equal(plain.scale(), 1);
  assert.deepEqual(texts(plain.widgets(ART, 480, 320)), ["12%"]);
  plain.update(0.65);
  assert.ok(plain.scale() < 1 && plain.scale() > 0, "shrinking");
  plain.update(0.2);
  assert.ok(plain.done);
  assert.equal(plain.scale(), 0);

  const paying = new NewBestPopup({ newBest: true, percent: 12, orbs: 3 });
  assert.equal(paying.centre(480, 320).y, 160 + 30);
  paying.update(0.5);
  assert.ok(Math.abs(paying.dim() - 100 / 255) < 1e-9);
  assert.deepEqual(texts(paying.widgets(ART, 480, 320)), ["12%", "+3"]);
  paying.update(1.2);
  assert.equal(paying.scale(), 1, "still holding at 1.7 s");
  assert.ok(!paying.done);
  paying.update(1);
  assert.ok(paying.done);
  assert.equal(paying.dim(), 0);
});

test("without a new best the pop-up says it paid", () => {
  const popup = new NewBestPopup({ newBest: false, percent: 40, orbs: 5 });
  popup.update(1);
  assert.deepEqual(texts(popup.widgets(ART, 480, 320)), ["New Reward!", "40%", "+5"]);
});

test("the orbs fly to the counter, which counts each in, tells the level once, and slides away", () => {
  const rand = seeded(7);
  let exits = 0;
  const reward = new OrbReward(4843, 3, { x: 240, y: 190 }, 480, 320, ART, () => exits++, rand);
  assert.deepEqual(texts(reward.widgets(ART)), ["4843"]);
  let t = 0;
  while (exits === 0 && t < 10) {
    reward.update(1 / 60, rand);
    t += 1 / 60;
  }
  assert.equal(exits, 1);
  assert.ok(t > 0.8 && t < 3, `landed after ${t.toFixed(2)} s`);
  assert.deepEqual(texts(reward.widgets(ART)), ["4846"]);
  for (let i = 0; i < 120; i++) reward.update(1 / 60, rand);
  assert.equal(exits, 1);
  assert.ok(reward.done);
});

test("past 60 orbs the extra ride on the ones that fly", () => {
  const rand = seeded(3);
  let exits = 0;
  const reward = new OrbReward(0, 250, { x: 240, y: 190 }, 480, 320, ART, () => exits++, rand);
  const flying = reward.widgets(ART).filter((w) => w.kind === "sprite").length - 1;
  assert.equal(flying, 60);
  for (let i = 0; i < 600 && exits === 0; i++) reward.update(1 / 60, rand);
  assert.equal(exits, 1);
  assert.deepEqual(texts(reward.widgets(ART)), ["250"]);
});
