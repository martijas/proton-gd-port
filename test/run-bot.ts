// Autoplayer CLI.
//
//   node --import tsx test/run-bot.ts [levelId|all] [--save] [--save-best] [--replay] [--verbose]
//                                    [--W=256 --D=4 --ticks=40e6 --ms=90000]
//                                    [--maxW=4096 --backoff=1920 --normalSizeAfter=<x> --seed=<n> --ringSize=16]
//                                    [--from=<tick>] [--threads=<n>]
//
// One line per level: "Stereo Madness 87.3% — killed at tick 18804 by hazard
// #1412 (obj 8) at (16350,105) …". With --save a completed run writes
// test/macros/<id>.json; with --replay the saved macro is replayed instead of
// searching (the regression path). --save-best also writes the furthest failed
// attempt to test/macros/<id>.best.json so it can be watched in debug.html.
// --seed solves with another random seed than MACRO_SEED and stores it in the
// macro, for a level whose random triggers the default seed sends down a
// rare branch. --from=<tick> plays the saved furthest attempt (or the macro)
// to that tick and solves on from there, for a run whose wrong turn came
// further back than a dead end reopens. --threads=<n> spreads the search over
// n worker threads (botParallel.ts); it finds the same inputs as one thread.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { formatReplay, formatReport, playPrefix, recordMacro, replay, solve, type BotConfig, type MacroInput } from "./bot";
import {
  OFFICIAL_LEVEL_IDS,
  levelName,
  loadObjectTable,
  loadBotLevel,
  macroPath,
  makeSim,
  projectPath,
  readMacro,
} from "./helpers";
import { solveParallel } from "./botParallel";

interface CliArgs {
  levels: number[];
  save: boolean;
  saveBest: boolean;
  replayOnly: boolean;
  verbose: boolean;
  seed?: number;
  from?: number;
  threads?: number;
  config: Partial<BotConfig>;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { levels: [], save: false, saveBest: false, replayOnly: false, verbose: false, config: {} };
  for (const arg of argv) {
    if (arg === "--save") out.save = true;
    else if (arg === "--save-best") out.saveBest = true;
    else if (arg === "--replay") out.replayOnly = true;
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const value = Number(eq < 0 ? "" : arg.slice(eq + 1));
      if (!Number.isFinite(value)) throw new Error(`Expected a number: ${arg}`);
      if (key === "W") out.config.W = value;
      else if (key === "D") out.config.D = value;
      else if (key === "N") out.config.N = value;
      else if (key === "ticks") out.config.maxTicks = value;
      else if (key === "ms") out.config.maxWallMs = value;
      else if (key === "maxW") out.config.maxW = value;
      else if (key === "backoff") out.config.maxBackoff = value;
      else if (key === "ringSize") out.config.ringSize = value;
      else if (key === "normalSizeAfter") out.config.normalSizeAfter = value;
      else if (key === "seed") out.seed = value;
      else if (key === "from") out.from = value;
      else if (key === "threads") out.threads = value;
      else throw new Error(`Unknown option ${arg}`);
    } else if (arg === "all") out.levels.push(...OFFICIAL_LEVEL_IDS);
    else {
      const id = Number(arg);
      if (!Number.isInteger(id)) throw new Error(`Unknown argument ${arg}`);
      out.levels.push(id);
    }
  }
  if (out.levels.length === 0) out.levels.push(...OFFICIAL_LEVEL_IDS);
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const table = loadObjectTable();
  let failures = 0;
  for (const id of args.levels) {
    const name = levelName(id);
    const level = await loadBotLevel(id);

    if (args.replayOnly) {
      const macro = readMacro(id);
      if (!macro) {
        console.log(`${name}: no saved macro (run with --save first)`);
        failures++;
        continue;
      }
      const r = replay(makeSim(level, table, macro.seed !== undefined ? { seed: macro.seed } : undefined), macro);
      console.log(formatReplay(name, r));
      if (!r.finished) failures++;
      continue;
    }

    const fresh = () => makeSim(level, table, args.seed !== undefined ? { seed: args.seed } : undefined);
    const sim = fresh();
    let prefix: MacroInput[] = [];
    if (args.from !== undefined) {
      const bestPath = projectPath(`test/macros/${id}.best.json`);
      const source = existsSync(bestPath) ? (JSON.parse(readFileSync(bestPath, "utf8")) as { inputs: MacroInput[] }) : readMacro(id);
      const played = source ? playPrefix(sim, source.inputs, args.from) : null;
      if (!played) {
        console.log(`${name}: no saved attempt that is still alive at tick ${args.from}`);
        failures++;
        continue;
      }
      prefix = played;
    }
    const withPrefix = (inputs: MacroInput[]) => (prefix.length > 0 ? [...prefix, ...inputs] : inputs);
    const config: Partial<BotConfig> = { ...args.config };
    if (args.verbose) config.log = (m) => console.log(`  ${name}: ${m}`);
    // The furthest death so far, raw, at every dead end: a long run that is
    // stuck can be studied without stopping it. Not a macro (no checkpoints).
    if (args.saveBest) {
      config.onDeadEnd = (inputs) => {
        mkdirSync(projectPath("test/deadends"), { recursive: true });
        const raw = { levelId: id, ...(args.seed !== undefined ? { seed: args.seed } : {}), inputs: withPrefix(inputs) };
        writeFileSync(projectPath(`test/deadends/${id}.json`), JSON.stringify(raw) + "\n");
      };
    }
    const threads = args.threads ?? 1;
    const r =
      threads > 1
        ? await solveParallel(sim, config, {
            threads,
            levelId: id,
            seed: args.seed,
            ...(args.from !== undefined ? { prefix, from: args.from } : {}),
          })
        : solve(sim, config);
    console.log(formatReport(name, r, args.verbose || !r.completed));
    if (!r.completed) {
      failures++;
      if (args.saveBest && r.inputs.length > 0) {
        const best = recordMacro(fresh(), withPrefix(r.inputs), id, name, args.seed);
        mkdirSync(projectPath("test/macros"), { recursive: true });
        const path = projectPath(`test/macros/${id}.best.json`);
        const reach = (m: { checkpoints?: { x: number }[] }) => Math.max(0, ...(m.checkpoints ?? []).map((c) => c.x));
        const old = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { checkpoints?: { x: number }[] }) : null;
        if (old && reach(old) > reach(best)) {
          console.log(`  kept ${path}: it reaches x ${reach(old).toFixed(0)}, this run x ${reach(best).toFixed(0)}`);
        } else {
          writeFileSync(path, JSON.stringify(best, null, 1) + "\n");
          console.log(`  saved furthest attempt to ${path} (${best.inputs.length} inputs)`);
        }
      }
      continue;
    }
    if (args.save) {
      const macro = recordMacro(fresh(), withPrefix(r.inputs), id, name, args.seed);
      if (macro.completedFrame === null) {
        console.log(`  ${name}: the solved inputs do not finish on replay — not saved (solver/sim mismatch)`);
        failures++;
        continue;
      }
      mkdirSync(projectPath("test/macros"), { recursive: true });
      writeFileSync(macroPath(id), JSON.stringify(macro, null, 1) + "\n");
      console.log(`  saved ${macroPath(id)} (${macro.inputs.length} inputs, ${macro.checkpoints.length} checkpoints)`);
    }
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
