// Turns a run played by hand on manualmacro.html into a saved macro.
//
//   node --import tsx test/record-manual.ts <levelId> [--seed=N] < run.json
//
// run.json is `{ "inputs": MacroInput[] }`. The inputs are replayed exactly as
// the tests replay them; only a run that finishes is written, to
// test/macros/<id>.json, and the level's furthest-attempt file goes with it.
// The macro it replaces is kept as test/_bak-<id>-before-manual.json.
// Prints one line of JSON: { ok, message, completedFrame? }.

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { recordMacro, type MacroInput } from "./bot";
import { levelName, loadBotLevel, loadObjectTable, macroPath, makeSim, projectPath } from "./helpers";

const id = Number(process.argv[2]);
const seedArg = process.argv.find((a) => a.startsWith("--seed="));
const seed = seedArg ? Number(seedArg.slice("--seed=".length)) : undefined;

function done(ok: boolean, message: string, extra: object = {}): never {
  console.log(JSON.stringify({ ok, message, ...extra }));
  process.exit(ok ? 0 : 1);
}

if (!Number.isInteger(id) || id <= 0) done(false, "No level id given.");
const body = JSON.parse(readFileSync(0, "utf8")) as { inputs?: MacroInput[] };
const inputs = (body.inputs ?? []).filter((i) => [1, 2, 3].includes(i.button) && Number.isFinite(i.frame));
if (inputs.length === 0) done(false, "The run has no inputs.");

const name = levelName(id);
const sim = makeSim(await loadBotLevel(id), loadObjectTable(), seed !== undefined ? { seed } : undefined);
const macro = { ...recordMacro(sim, inputs, id, name, seed), botInfo: { name: "manualmacro", version: "1" } };
if (macro.completedFrame === null) {
  writeFileSync(projectPath(`test/_manual-${id}.json`), JSON.stringify(macro));
  done(false, `${name}: the run didn't finish when replayed, so it wasn't saved. It's kept as test/_manual-${id}.json.`);
}

const path = macroPath(id);
if (existsSync(path)) copyFileSync(path, projectPath(`test/_bak-${id}-before-manual.json`));
writeFileSync(path, JSON.stringify(macro, null, 1) + "\n");
rmSync(projectPath(`test/macros/${id}.best.json`), { force: true });
done(true, `${name}: saved, finishing at tick ${macro.completedFrame}.`, { completedFrame: macro.completedFrame });
