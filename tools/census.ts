// Prints which object ids the official levels use, most common first.
import { readFileSync, writeFileSync } from "node:fs";
import { loadLevel } from "../src/level/decode";
import { LEVELS_DIR as LEVELS } from "./paths";
const ids = [...Array.from({ length: 22 }, (_, i) => i + 1), 3001, 5001, 5002, 5003, 5004];
const counts = new Map<number, number>();
const perLevel: Record<string, number[]> = {};
for (const n of ids) {
  const lv = await loadLevel(readFileSync(`${LEVELS}/${n}.txt`, "latin1"));
  const set = new Set<number>();
  for (const o of lv.objects) { counts.set(o.id, (counts.get(o.id) ?? 0) + 1); set.add(o.id); }
  perLevel[n] = [...set].sort((a, b) => a - b);
}
const sorted = [...counts].sort((a, b) => b[1] - a[1]);
writeFileSync("data/census.json", JSON.stringify({ counts: Object.fromEntries(sorted), perLevel }, null, 1));
console.log("distinct ids:", counts.size);
console.log(sorted.slice(0, 40).map(([id, c]) => `${id}:${c}`).join(" "));
