// Re-records a saved macro against the current physics.
//
//   node --import tsx test/restamp-macro.ts <levelId> [levelId...]
//
// The inputs are kept as they are; the checkpoints and the physics stamp are
// rebuilt, so a macro that still finishes after a physics change stays a valid
// regression fixture without asking the solver to find the level again. A macro
// that no longer finishes is left untouched and reported.

import { writeFileSync } from "node:fs";
import { recordMacro } from "./bot";
import { levelName, loadBotLevel, loadObjectTable, macroPath, makeSim, readMacro } from "./helpers";

async function main(): Promise<number> {
  const ids = process.argv.slice(2).map(Number);
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n))) {
    console.error("usage: restamp-macro.ts <levelId> [levelId...]");
    return 2;
  }
  const table = loadObjectTable();
  let failures = 0;
  for (const id of ids) {
    const name = levelName(id);
    const old = readMacro(id);
    if (!old) {
      console.log(`${name}: no saved macro`);
      failures++;
      continue;
    }
    const sim = makeSim(await loadBotLevel(id), table, old.seed !== undefined ? { seed: old.seed } : undefined);
    const macro = recordMacro(sim, old.inputs, id, name, old.seed);
    if (macro.completedFrame === null) {
      console.log(`${name}: the saved inputs no longer finish — left alone, re-solve it`);
      failures++;
      continue;
    }
    writeFileSync(macroPath(id), JSON.stringify(macro, null, 1) + "\n");
    console.log(`${name}: re-stamped (${macro.inputs.length} inputs, finishes at tick ${macro.completedFrame})`);
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 2;
  },
);
