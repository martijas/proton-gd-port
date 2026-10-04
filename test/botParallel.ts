// solve() spread over worker threads (botWorker.ts).
//
// The workers hold the snapshots and do the stepping and scoring; this thread
// keeps the beam, the lineages and the checkpoint ring, and makes every
// decision in the same order solve() makes it, so the two find the same
// inputs. A node's snapshot stays on the worker that made it, and so do its
// children; when one worker ends up with far more of the beam than the rest
// (after a dead end narrows the search to one line), snapshots are moved.

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type { PlayerInput, Sim, SimSnapshot } from "../src/physics/types";
import {
  CLASSIC_BRANCHES,
  DEFAULT_BOT_CONFIG,
  PLATFORMER_BRANCHES,
  RELEASE,
  bubbleMaxX,
  formOf,
  inputEvents,
  materializeInputs,
  planFromCheckpoint,
  selectDiverse,
  type BotConfig,
  type Checkpoint,
  type DeathReport,
  type Lineage,
  type MacroInput,
  type Node,
  type PlanStep,
  type SolveResult,
} from "./bot";
import type { ExportedSnapshot } from "./snapTransfer";
import type { ExpandResult, WorkerInit, WorkerRequest } from "./botWorker";

export interface ParallelOptions {
  threads: number;
  levelId: number;
  seed?: number;
  /** The inputs played before the solve starts, and the tick they were played to (--from). */
  prefix?: MacroInput[];
  from?: number;
}

/** A node's snapshot: which worker holds it, under which id. Shared by every Node that refers to it. */
interface Handle {
  w: number;
  id: number;
  refs: number;
}

class Pool {
  private readonly workers: Worker[] = [];
  private readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>[] = [];
  private nextReq = 0;
  readonly free: number[][] = [];

  private constructor() {}

  static async start(threads: number, init: WorkerInit): Promise<{ pool: Pool; starts: { x: number; y: number; hash: number; tick: number }[] }> {
    const pool = new Pool();
    const ready: Promise<{ x: number; y: number; hash: number; tick: number }>[] = [];
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL("./botWorker.mjs", import.meta.url), { workerData: init, execArgv: [] });
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      pool.workers.push(w);
      pool.pending.push(pending);
      pool.free.push([]);
      ready.push(
        new Promise((resolve, reject) => {
          w.on("message", (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
            if (m.id === -1) return resolve(m.value as { x: number; y: number; hash: number; tick: number });
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.ok) p.resolve(m.value);
            else p.reject(new Error(`worker ${i}: ${m.error}`));
          });
          w.on("error", (e) => {
            reject(e);
            for (const p of pending.values()) p.reject(e);
          });
        }),
      );
    }
    return { pool, starts: await Promise.all(ready) };
  }

  get size(): number {
    return this.workers.length;
  }

  call<T>(w: number, msg: WorkerRequest): Promise<T> {
    const id = this.nextReq++;
    return new Promise<T>((resolve, reject) => {
      this.pending[w].set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.workers[w].postMessage({ id, msg });
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

export function defaultThreads(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

const handleOf = (n: Node): Handle => n.snap as unknown as Handle;

export async function solveParallel(sim: Sim, overrides: Partial<BotConfig>, opts: ParallelOptions): Promise<SolveResult> {
  const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, ...overrides };
  const t0 = performance.now();
  const platformer = sim.level.header.platformer;
  const branches = platformer ? PLATFORMER_BRANCHES : CLASSIC_BRANCHES;
  const { log, onDeadEnd, ...plainCfg } = cfg;
  const { pool, starts } = await Pool.start(opts.threads, {
    levelId: opts.levelId,
    seed: opts.seed,
    prefix: opts.prefix ?? null,
    from: opts.from ?? null,
    cfg: plainCfg,
  });
  for (const s of starts) {
    if (s.tick !== sim.tick || s.x !== sim.state.x || s.y !== sim.state.y || s.hash !== sim.stateHash()) {
      await pool.stop();
      throw new Error("a worker's sim does not start where this one does");
    }
  }
  try {
    return await search();
  } finally {
    await pool.stop();
  }

  async function search(): Promise<SolveResult> {
    const k = pool.size;
    const retain = (n: Node): void => {
      handleOf(n).refs++;
    };
    const release = (n: Node): void => {
      const h = handleOf(n);
      if (--h.refs === 0) pool.free[h.w].push(h.id);
    };
    const drop = (h: Handle): void => {
      if (h.refs === 0) pool.free[h.w].push(h.id);
    };

    const startTick = sim.tick;
    const root: Lineage = { parent: null, tick: startTick, input: RELEASE, ticks: 0, events: null, subtreeMaxX: sim.state.x };
    const rootHandle: Handle = { w: 0, id: 0, refs: 0 };
    let beam: Node[] = [
      { snap: rootHandle as unknown as SimSnapshot, input: RELEASE, lineage: root, score: 0, y: sim.state.y, form: formOf(sim.state) },
    ];
    beam.forEach(retain);
    for (let w = 1; w < k; w++) pool.free[w].push(0);
    const setBeam = (next: Node[]): void => {
      next.forEach(retain);
      beam.forEach(release);
      beam = next;
    };

    let tick = startTick;
    let used = 0;
    let W = cfg.W;
    let D = cfg.D;
    let backoff = cfg.checkpointEvery;
    let furthestTick = startTick;
    let deadEndFrontier = Number.NEGATIVE_INFINITY;
    let lastCheckpointTick = startTick - cfg.checkpointEvery;
    const ring: Checkpoint[] = [];
    const dropRing = (from: number): void => {
      for (const cp of ring.splice(from)) cp.beam.forEach(release);
    };
    let best: { report: DeathReport; lineage: Lineage } | null = null;
    let stopReason: SolveResult["stopReason"] = "dead end";
    let focusedOn: Lineage | null = null;

    const focusNode = (death: Lineage): { ringIdx: number; node: Node } | null => {
      for (let i = ring.length - 1; i >= 0; i--) {
        const cp = ring[i];
        if (cp.tick > death.tick - cfg.focusBack) continue;
        let cur: Lineage | null = death;
        while (cur && cur.tick > cp.tick) cur = cur.parent;
        if (!cur) return null;
        cp.byLineage ??= new Map(cp.beam.map((n) => [n.lineage, n]));
        const node = cp.byLineage.get(cur);
        return node ? { ringIdx: i, node } : null;
      }
      return null;
    };

    const latestCheckpoint = (): Checkpoint | null => {
      for (let i = ring.length - 1; i >= 0; i--) if (ring[i].tick <= tick) return ring[i];
      return null;
    };

    const report = (from: Handle, plan: PlanStep[], held: boolean): Promise<DeathReport> =>
      pool.call<DeathReport>(from.w, { op: "report", id: from.id, plan, held });

    const reportFor = (parent: Node, lineage: Lineage, held: boolean): Promise<DeathReport> => {
      const cp = latestCheckpoint();
      const viaCp = cp ? planFromCheckpoint(cp, lineage) : null;
      if (viaCp) return report(handleOf(viaCp.node), viaCp.plan, held);
      return report(handleOf(parent), [{ input: lineage.input, ticks: lineage.ticks }], held);
    };

    const finish = (completed: boolean, lineage: Lineage | null, rep0: DeathReport | null): SolveResult => {
      const wallMs = performance.now() - t0;
      const empty: DeathReport = {
        furthest: { tick, x: 0, y: 0, mode: sim.state.mode, held: false },
        bestX: 0,
        bestPercent: 0,
        killer: null,
        playerRect: null,
        trace: [],
        nearMisses: [],
      };
      const rep = rep0 ?? empty;
      return {
        ...rep,
        completed,
        ticks: rep.furthest.tick,
        inputs: lineage ? materializeInputs(lineage) : [],
        simTicksUsed: used,
        wallMs,
        stopReason: completed ? "completed" : stopReason,
      };
    };

    /** Moves snapshots off a worker holding much more than its share of the beam. */
    const balance = async (): Promise<void> => {
      if (beam.length < 2 * k) return;
      const target = Math.ceil(beam.length / k);
      const byWorker: Node[][] = Array.from({ length: k }, () => []);
      for (const n of beam) byWorker[handleOf(n).w].push(n);
      if (Math.max(...byWorker.map((l) => l.length)) <= target * 1.25) return;
      const surplus: Node[] = [];
      for (const list of byWorker) if (list.length > target) surplus.push(...list.slice(target));
      const moves = new Map<string, Node[]>();
      let si = 0;
      for (let w = 0; w < k && si < surplus.length; w++) {
        for (let room = target - byWorker[w].length; room > 0 && si < surplus.length; room--) {
          const n = surplus[si++];
          const key = `${handleOf(n).w}>${w}`;
          (moves.get(key) ?? moves.set(key, []).get(key)!).push(n);
        }
      }
      await Promise.all(
        [...moves].map(async ([key, nodes]) => {
          const [from, to] = key.split(">").map(Number);
          const handles = [...new Set(nodes.map(handleOf))];
          const items = await pool.call<ExportedSnapshot[]>(from, { op: "export", ids: handles.map((h) => h.id) });
          const ids = await pool.call<number[]>(to, { op: "import", items });
          handles.forEach((h, i) => {
            pool.free[from].push(h.id);
            h.w = to;
            h.id = ids[i];
          });
        }),
      );
    };

    for (;;) {
      if (used >= cfg.maxTicks) {
        stopReason = "tick budget";
        break;
      }
      if (performance.now() - t0 > cfg.maxWallMs) {
        stopReason = "wall clock";
        break;
      }
      if (tick - lastCheckpointTick >= cfg.checkpointEvery) {
        beam.forEach(retain);
        ring.push({ tick, beam, byLineage: null });
        if (ring.length > cfg.ringSize) ring.shift()!.beam.forEach(release);
        lastCheckpointTick = tick;
      }
      if (tick > furthestTick) furthestTick = tick;
      if (tick > deadEndFrontier + cfg.checkpointEvery) {
        backoff = cfg.checkpointEvery;
        deadEndFrontier = Number.NEGATIVE_INFINITY;
      }

      await balance();
      const perWorker: number[][] = Array.from({ length: k }, () => []);
      const where: { w: number; at: number }[] = beam.map((n) => {
        const h = handleOf(n);
        perWorker[h.w].push(h.id);
        return { w: h.w, at: perWorker[h.w].length - 1 };
      });
      const results = await Promise.all(
        perWorker.map((ids, w) => {
          const free = pool.free[w].splice(0);
          return ids.length || free.length ? pool.call<ExpandResult>(w, { op: "expand", ids, D, free }) : null;
        }),
      );
      for (const r of results) if (r) used += r.used;

      const next: Node[] = [];
      const seen = new Map<string, number>();
      for (let bi = 0; bi < beam.length; bi++) {
        const node = beam[bi];
        const { w, at } = where[bi];
        const r = results[w]!;
        for (let b = 0; b < branches.length; b++) {
          const input: PlayerInput = branches[b];
          const j = at * branches.length + b;
          const stepped = r.stepped[j];
          const lineage: Lineage = {
            parent: node.lineage,
            tick: tick + stepped,
            input,
            ticks: stepped,
            events: inputEvents(node.input, input, tick),
            subtreeMaxX: r.x[j],
          };
          const outcome = r.outcome[j];
          if (outcome === 2) {
            bubbleMaxX(node.lineage, r.x[j]);
            return finish(true, lineage, await reportFor(node, lineage, input.jump));
          }
          if (outcome === 1) {
            bubbleMaxX(node.lineage, r.x[j]);
            if (!best || r.x[j] > best.report.bestX) best = { report: await reportFor(node, lineage, input.jump), lineage };
            continue;
          }
          if (outcome === 3) continue;
          const childHandle: Handle = { w, id: r.child[j], refs: 0 };
          const key = r.keys[j];
          const score = r.score[j];
          const prevIdx = seen.get(key);
          if (prevIdx !== undefined && next[prevIdx].score >= score) {
            drop(childHandle);
            continue;
          }
          const child: Node = { snap: childHandle as unknown as SimSnapshot, input, lineage, score, y: r.y[j], form: r.form[j] };
          if (prevIdx !== undefined) {
            drop(handleOf(next[prevIdx]));
            next[prevIdx] = child;
          } else {
            seen.set(key, next.length);
            next.push(child);
          }
        }
      }

      if (next.length === 0) {
        const focus = best && cfg.focusBack > 0 && best.lineage !== focusedOn ? focusNode(best.lineage) : null;
        if (focus) {
          focusedOn = best!.lineage;
          const deadTick = tick;
          setBeam([focus.node]);
          dropRing(focus.ringIdx + 1);
          tick = ring[focus.ringIdx].tick;
          lastCheckpointTick = tick;
          log?.(`dead end at tick ${deadTick} → focusing on the furthest death's line from tick ${tick}`);
          continue;
        }
        let cpIdx = -1;
        for (let i = ring.length - 1; i >= 0; i--) {
          if (ring[i].tick <= tick - backoff) {
            cpIdx = i;
            break;
          }
        }
        if (cpIdx < 0 && ring.length > 0) cpIdx = 0;
        if (cpIdx < 0 || backoff > cfg.maxBackoff) {
          stopReason = "dead end";
          break;
        }
        const cp = ring[cpIdx];
        const deadTick = tick;
        deadEndFrontier = Math.max(deadEndFrontier, furthestTick);
        setBeam([...cp.beam].sort((a, b) => b.lineage.subtreeMaxX - a.lineage.subtreeMaxX));
        dropRing(cpIdx + 1);
        tick = cp.tick;
        lastCheckpointTick = cp.tick;
        backoff *= 2;
        W = Math.min(W * 2, cfg.maxW);
        D = Math.max(1, D >> 1);
        const fd = best?.report;
        const fdText = fd
          ? `; furthest death at tick ${fd.furthest.tick} (${fd.furthest.x.toFixed(2)},${fd.furthest.y.toFixed(2)}) ${fd.furthest.mode}` +
            (fd.killer ? ` by #${fd.killer.index} (obj ${fd.killer.id})` : "")
          : "";
        log?.(`dead end at tick ${deadTick} → reopening ${beam.length} nodes at tick ${cp.tick} (W=${W}, D=${D}, next backoff ${backoff})${fdText}`);
        if (best && onDeadEnd) onDeadEnd(materializeInputs(best.lineage));
        continue;
      }

      next.sort((a, b) => b.score - a.score);
      const kept = selectDiverse(next, W, cfg.diversityCap);
      setBeam(kept);
      for (const n of next) drop(handleOf(n));
      tick += D;
    }

    if (best) return finish(false, best.lineage, best.report);
    const lead = beam.reduce((a, b) => (b.lineage.subtreeMaxX > a.lineage.subtreeMaxX ? b : a), beam[0]);
    return finish(false, lead.lineage, await report(handleOf(lead), [], lead.input.jump));
  }
}
