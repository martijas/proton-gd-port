// Prints how much of the trigger set this port handles.
//
//   npm run triggers            what is covered, and the heaviest gaps
//   npm run triggers -- --all   every id the official levels place
//
// Weighted by placements rather than by id, because that is what decides
// whether a level looks right: getting Pulse wrong costs 1,376 placements and
// getting Background Speed wrong costs one.

import { TRIGGER_CATALOGUE } from "../src/triggers/catalogue";
import { coverage, statusOf, type TriggerStatus } from "../src/triggers/registry";

const all = process.argv.includes("--all");
const c = coverage();

function bar(n: number, total: number, width = 28): string {
  const filled = total === 0 ? 0 : Math.round((n / total) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;
}

const handled = c.byStatus.done.placements + c.byStatus.unsupported.placements;

console.log();
console.log(`  triggers the official levels place   ${c.usedIds} ids, ${c.placements.toLocaleString()} placements`);
console.log(`  ids in the table but never placed    ${TRIGGER_CATALOGUE.size - c.usedIds}`);
console.log();
const order: TriggerStatus[] = ["done", "partial", "todo", "unsupported"];
for (const status of order) {
  const s = c.byStatus[status];
  console.log(
    `  ${status.padEnd(12)} ${String(s.ids).padStart(3)} ids  ${String(s.placements).padStart(6)} placements  ${bar(s.placements, c.placements)}  ${pct(s.placements, c.placements)}`,
  );
}
console.log();
console.log(`  handled                              ${pct(handled, c.placements)} of placements`);
console.log(`  levels with nothing outstanding      ${c.levelsFullyCovered.length} of 27${c.levelsFullyCovered.length ? `: ${c.levelsFullyCovered.join(" ")}` : ""}`);

const show = all ? c.worstGaps : c.worstGaps.slice(0, 15);
if (show.length > 0) {
  console.log();
  console.log(`  ${all ? "every gap" : "the heaviest gaps"}, by how often the levels place them:`);
  for (const { info, status } of show) {
    const where = info.levels.length > 4 ? `${info.levels.length} levels` : `level ${info.levels.join(", ")}`;
    console.log(
      `    ${String(info.id).padStart(5)}  ${String(info.uses).padStart(5)}  ${status.padEnd(8)} ${(info.name || "(unnamed)").padEnd(34)} ${where}`,
    );
  }
  if (!all && c.worstGaps.length > show.length) {
    console.log(`    … and ${c.worstGaps.length - show.length} more; pass --all to see them`);
  }
}
console.log();
