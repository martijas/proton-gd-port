import { loadOfficialLevel, OFFICIAL_LEVEL_IDS, levelName } from "../../test/helpers";

const MODE_PORTALS: Record<number, string> = {
  12: "cube", 13: "ship", 47: "ball", 111: "ufo", 660: "wave", 745: "robot", 1331: "spider", 1933: "swing",
};
const GRAVITY = new Set([10, 11, 2926]);

async function main(): Promise<void> {
  let total = 0;
  const byMode = new Map<string, number>();
  let gravity = 0;
  for (const id of OFFICIAL_LEVEL_IDS) {
    const lv = await loadOfficialLevel(id);
    let n = 0;
    for (const o of lv.objects) {
      const m = MODE_PORTALS[o.id];
      if (m) { n++; total++; byMode.set(m, (byMode.get(m) ?? 0) + 1); }
      if (GRAVITY.has(o.id)) gravity++;
    }
    if (n > 0) console.log(`  ${levelName(id).padEnd(22)} ${String(n).padStart(3)} mode portals`);
  }
  console.log(`\n  ${total} mode portals across the official levels, ${gravity} gravity portals`);
  console.log("  " + [...byMode].sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m} ${c}`).join("  "));
}
void main();
