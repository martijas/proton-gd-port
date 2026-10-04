// One thread of solveParallel (botParallel.ts). Holds its own sim of the level
// at the solve's start and the snapshots of the nodes it owns, and does the
// stepping, scoring and death reports for them; the main thread decides which
// nodes live.

import { parentPort, workerData } from "node:worker_threads";
import type { PlayerInput, SimSnapshot } from "../src/physics/types";
import {
  CLASSIC_BRANCHES,
  ClearanceIndex,
  DEFAULT_BOT_CONFIG,
  PLATFORMER_BRANCHES,
  PlatformerGuide,
  bucketKey,
  captureTrace,
  formOf,
  makeRanker,
  playPrefix,
  reportFromState,
  type BotConfig,
  type MacroInput,
  type PlanStep,
} from "./bot";
import { loadBotLevel, loadObjectTable, makeSim } from "./helpers";
import { exportSnapshot, importSnapshot, type ExportedSnapshot } from "./snapTransfer";

export interface WorkerInit {
  levelId: number;
  seed?: number;
  prefix: MacroInput[] | null;
  from: number | null;
  cfg: Omit<BotConfig, "log" | "onDeadEnd">;
}

/** Per node and branch, in order: what stepping it did. */
export interface ExpandResult {
  /** 0 alive, 1 dead, 2 finished, 3 dropped (still mini past normalSizeAfter). */
  outcome: Uint8Array;
  stepped: Uint8Array;
  x: Float64Array;
  y: Float64Array;
  form: Int32Array;
  score: Float64Array;
  child: Int32Array;
  keys: string[];
  used: number;
}

export type WorkerRequest =
  | { op: "expand"; ids: number[]; D: number; free: number[] }
  | { op: "free"; ids: number[] }
  | { op: "report"; id: number; plan: PlanStep[]; held: boolean }
  | { op: "export"; ids: number[] }
  | { op: "import"; items: ExportedSnapshot[] }
  | { op: "stop" };

const init = workerData as WorkerInit;
const cfg = { ...DEFAULT_BOT_CONFIG, ...init.cfg } as BotConfig;
const sim = makeSim(await loadBotLevel(init.levelId), loadObjectTable(), init.seed !== undefined ? { seed: init.seed } : undefined);
if (init.prefix && init.from !== null && !playPrefix(sim, init.prefix, init.from)) throw new Error("the prefix dies before the start");
const platformer = sim.level.header.platformer;
const branches: readonly PlayerInput[] = platformer ? PLATFORMER_BRANCHES : CLASSIC_BRANCHES;
const clearanceIndex = new ClearanceIndex(sim, cfg.lookaheadUnits);
const guide = platformer ? new PlatformerGuide(sim) : null;
const rank = makeRanker(sim, cfg, clearanceIndex, guide);

const snaps = new Map<number, SimSnapshot>();
let nextId = 0;
const store = (s: SimSnapshot): number => {
  snaps.set(nextId, s);
  return nextId++;
};
store(sim.snapshot());

function snapOf(id: number): SimSnapshot {
  const s = snaps.get(id);
  if (!s) throw new Error(`no snapshot ${id}`);
  return s;
}

function expand(ids: number[], D: number): ExpandResult {
  const n = ids.length * branches.length;
  const out: ExpandResult = {
    outcome: new Uint8Array(n),
    stepped: new Uint8Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    form: new Int32Array(n),
    score: new Float64Array(n),
    child: new Int32Array(n).fill(-1),
    keys: new Array<string>(n).fill(""),
    used: 0,
  };
  let k = 0;
  for (const id of ids) {
    const snap = snapOf(id);
    for (const input of branches) {
      sim.restore(snap);
      let stepped = 0;
      while (stepped < D) {
        sim.step(input, input);
        out.used++;
        stepped++;
        if (sim.state.dead || sim.state.finished) break;
      }
      const st = sim.state;
      out.stepped[k] = stepped;
      out.x[k] = st.x;
      out.y[k] = st.y;
      if (st.finished) out.outcome[k] = 2;
      else if (st.dead) out.outcome[k] = 1;
      else if (cfg.normalSizeAfter !== undefined && st.mini && st.x > cfg.normalSizeAfter) out.outcome[k] = 3;
      else {
        out.keys[k] = bucketKey(sim, input, platformer);
        out.form[k] = formOf(st);
        const r = rank(input);
        out.used += r.used;
        out.score[k] = r.score;
        out.child[k] = store(r.snap ?? sim.snapshot());
      }
      k++;
    }
  }
  return out;
}

function handle(msg: WorkerRequest): unknown {
  switch (msg.op) {
    case "expand":
      for (const id of msg.free) snaps.delete(id);
      return expand(msg.ids, msg.D);
    case "free":
      for (const id of msg.ids) snaps.delete(id);
      return null;
    case "report": {
      const capture = msg.plan.length ? captureTrace(sim, snapOf(msg.id), msg.plan) : (sim.restore(snapOf(msg.id)), { trace: [], nearMisses: [] });
      return reportFromState(sim, msg.held, capture);
    }
    case "export":
      return msg.ids.map((id) => exportSnapshot(sim, snapOf(id)));
    case "import":
      return msg.items.map((e) => store(importSnapshot(sim, e)));
    case "stop":
      process.exit(0);
  }
}

parentPort!.on("message", ({ id, msg }: { id: number; msg: WorkerRequest }) => {
  try {
    parentPort!.postMessage({ id, ok: true, value: handle(msg) });
  } catch (e) {
    parentPort!.postMessage({ id, ok: false, error: e instanceof Error ? e.stack : String(e) });
  }
});
parentPort!.postMessage({ id: -1, ok: true, value: { x: sim.state.x, y: sim.state.y, hash: sim.stateHash(), tick: sim.tick } });
