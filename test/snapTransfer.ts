// Moving a simulation snapshot to another thread.
//
// A snapshot shares its arrays with the sim that took it and with the
// snapshots before it, and its players point back at that sim, so it cannot
// be posted as it is. exportSnapshot makes a self-contained copy without the
// back references; importSnapshot loads one into another sim built from the
// same level and returns a native snapshot of it.

import type { Sim, SimSnapshot } from "../src/physics/types";

export interface ExportedSnapshot {
  tick: number;
  data: unknown;
}

function plainPlayer(p: object | null, sim: Sim): object | null {
  if (!p) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== sim) out[k] = v;
  return out;
}

export function exportSnapshot(sim: Sim, snap: SimSnapshot): ExportedSnapshot {
  const d = snap.opaque as { p1: object; p2: object | null };
  return { tick: snap.tick, data: { ...d, p1: plainPlayer(d.p1, sim), p2: plainPlayer(d.p2, sim) } };
}

/** Leaves `sim` at the imported state. */
export function importSnapshot(sim: Sim, e: ExportedSnapshot): SimSnapshot {
  sim.restore({ tick: e.tick, opaque: e.data });
  return sim.snapshot();
}
