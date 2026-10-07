// The platformer guide used by the autoplayer on The Tower floors: goals are
// the touch spawns that fire End, teleports are edges, and a node on the end
// spawn outranks every other while the finish delay runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MacroPlayer } from "../src/debug/macro";
import { PlatformerGuide } from "./bot";
import { loadOfficialLevel, makeSim, readMacro } from "./helpers";

test("each tower floor's guide finds its end spawn and teleports", async () => {
  for (const id of [5001, 5002, 5003, 5004] as const) {
    const sim = makeSim(await loadOfficialLevel(id));
    const guide = new PlatformerGuide(sim);
    assert.equal(guide.goalCount, 1, `${id} goal`);
    assert.ok(guide.teleportCount >= 1, `${id} teleports`);
    assert.ok(guide.progressScore(sim.state) > 0, `${id} start score`);
  }
});

test("The Tower's end spawn keeps a finisher alive through the delay", async () => {
  const macro = readMacro(5001);
  assert.ok(macro, "The Tower macro");
  const sim = makeSim(await loadOfficialLevel(5001));
  const player = new MacroPlayer(macro);
  let sawBonus = false;
  for (let t = 0; t < 25_000 && !sim.state.finished && !sim.state.dead; t++) {
    const inp = player.at(t);
    sim.step(inp.p1, inp.p2);
    if (sim.state.x < 10000) continue;
    const bonus = new PlatformerGuide(sim).endingBonus(sim);
    if (bonus > 0) {
      sawBonus = true;
      break;
    }
  }
  assert.ok(sawBonus || sim.state.finished, "ending bonus before or at the finish");
});
