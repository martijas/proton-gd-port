// Adds the render flags to data/ref/gd_2206_customSetup_objectTypes.csv.
//
//   python tools/ref-run_customsetup2.py     # interprets the decompile
//   npx tsx tools/ref-extend-customsetup.ts  # folds the extra flags into the csv
//
// The Python step interprets GameObject::customSetup() from the 2.206 decompile
// and records twenty-four members per object, but the csv that the rest of the
// pipeline reads was only ever written with seventeen of them. The six below
// decide how an object is drawn rather than how it behaves, so the renderer
// needs them and nothing else in the repo has them.
//
// Every column that was already in the csv is copied through byte for byte, and
// the tool refuses to write if a value it would have produced disagrees with one
// already there — that check is what says the freshly interpreted decompile is
// the same one the csv came from.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, "..", "data", "ref");
const CSV = join(REF, "gd_2206_customSetup_objectTypes.csv");
const JSON_PATH = join(REF, "customSetup_types_2206.json");

/** New column name → the member the interpreter records it under. */
const ADDED: Record<string, string> = {
  isRotationAligned: "m_isRotationAligned",
  hasNoGlow: "m_hasNoGlow",
  dontFadeTinted: "m_dontFadeTinted",
  isTintObject: "m_isTintObject",
  isSolidColorBlock: "m_isSolidColorBlock",
  useSpecialLight: "m_useSpecialLight",
};

/** Columns already in the csv, and the member each was written from. */
const EXISTING: Record<string, string> = {
  objectType: "m_objectType",
  typeName: "typeName",
  typeExplicitlySet: "typeExplicitlySet",
  hitboxWidth_m_width: "m_width",
  hitboxHeight_m_height: "m_height",
  objectRadius: "m_objectRadius",
  isSolidFlag: "m_isSolid",
  isPassable: "m_isPassable",
  spriteWidthScale: "m_spriteWidthScale",
  spriteHeightScale: "m_spriteHeightScale",
  defaultZOrder: "m_defaultZOrder",
  defaultZLayer: "m_defaultZLayer",
  isPortalObject: "m_isPortalObject",
  isSpecialObject: "m_isSpecialObject",
  hasSepcialChild: "m_hasSepcialChild",
};

type Record24 = Record<string, unknown>;

/** The csv writes booleans as 0/1 and omits nothing; the json omits what was never set. */
function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "0";
  if (value === true) return "1";
  if (value === false) return "0";
  return String(value);
}

function same(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

const records = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Record<string, Record24>;
const text = readFileSync(CSV, "utf8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.replace(/\s+$/, "").split(/\r?\n/);
const header = lines[0].split(",");

for (const name of Object.keys(ADDED)) {
  if (header.includes(name)) throw new Error(`${name} is already a column; the csv has been extended before`);
}
const idCol = header.indexOf("id");
if (idCol < 0) throw new Error("the csv has no id column");

const out: string[] = [[...header, ...Object.keys(ADDED)].join(",")];
const drift: string[] = [];
let missing = 0;

for (const line of lines.slice(1)) {
  const cells = line.split(",");
  const id = cells[idCol];
  const rec = records[id];
  if (!rec) {
    missing++;
    out.push([...cells, ...Object.keys(ADDED).map(() => "")].join(","));
    continue;
  }
  // Re-derive what is already there and complain if it moved.
  for (const [column, member] of Object.entries(EXISTING)) {
    const at = header.indexOf(column);
    if (at < 0) continue;
    const want = cells[at] ?? "";
    const got = cell(rec[member]);
    if (!same(got, want === "" ? "0" : want)) drift.push(`id ${id} ${column}: csv ${JSON.stringify(want)}, decompile ${JSON.stringify(got)}`);
  }
  out.push([...cells, ...Object.values(ADDED).map((member) => cell(rec[member]))].join(","));
}

if (drift.length > 0) {
  console.error(`${drift.length} value(s) disagree with the csv — the decompile is not the one it was built from:`);
  for (const d of drift.slice(0, 10)) console.error(`  ${d}`);
  process.exitCode = 1;
} else {
  writeFileSync(CSV, out.join(eol) + eol);
  const counts = Object.entries(ADDED).map(([column, member]) => {
    const n = Object.values(records).filter((r) => r[member] === true).length;
    return `${column} ${n}`;
  });
  console.log(`${out.length - 1} rows, every existing value unchanged${missing > 0 ? `, ${missing} with no record` : ""}`);
  console.log(`objects with each flag set: ${counts.join("  ")}`);
}
