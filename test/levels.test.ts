// Every official level must be completable by the autoplayer. The search is
// slow (up to a few minutes per level), so it only runs with GD_BOT=1; the saved
// macros in test/macros are replayed on every run instead, which is cheap and
// pinpoints the first checkpoint where the physics drifted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReplay, formatReport, replay, solve } from "./bot";
import { OFFICIAL_LEVEL_IDS, levelName, loadOfficialLevel, makeSim, readMacro } from "./helpers";

const BOT_ENABLED = process.env.GD_BOT === "1";
const SKIP_REASON = "set GD_BOT=1 to run the autoplayer";

for (const id of OFFICIAL_LEVEL_IDS) {
  const name = levelName(id);

  test(`${name} (${id}): saved macro still completes`, { skip: readMacro(id) ? false : `no macro saved for ${id}` }, async () => {
    const macro = readMacro(id);
    assert.ok(macro);
    const sim = makeSim(await loadOfficialLevel(id));
    const r = replay(sim, macro);
    if (!r.simHashMatches) console.log(`  ${name}: physics or hitboxes changed since the macro was solved`);
    if (!r.finished || r.firstDivergence) console.log(formatReplay(name, r));
    assert.ok(r.finished, `${name}: macro replay did not finish (see report above)`);
  });

  test(`${name} (${id}): autoplayer completes the level`, { skip: BOT_ENABLED ? false : SKIP_REASON }, async () => {
    const sim = makeSim(await loadOfficialLevel(id));
    // W=256/D=4 dead-ends on orb chains and tight ship dives that W=1024/D=2 clears.
    const r = solve(sim, { W: 1024, D: 2, maxTicks: 120e6, maxWallMs: 150_000 });
    if (!r.completed) console.log(formatReport(name, r, true));
    assert.ok(r.completed, formatReport(name, r));
  });
}
