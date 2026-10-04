// Saves an online level's data to test/levels/<id>.txt so the autoplayer can
// solve it offline:
//
//   node --import tsx test/fetch-online-level.ts <levelId>
//
// Goes straight to RobTop's servers; set GD_SERVER to a tunnel's base URL
// (e.g. http://localhost:3000/api/robtop-server) to go through one instead.

import { mkdirSync, writeFileSync } from "node:fs";
import { setHostConfig } from "../src/online/hostConfig";
import { downloadLevel } from "../src/online/robtop";
import { projectPath } from "./helpers";

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) throw new Error("usage: fetch-online-level.ts <levelId>");
const tunnel = process.env.GD_SERVER;
setHostConfig({ server: tunnel ? { mode: "hostApi", hostApi: tunnel } : { mode: "direct", hostApi: "" }, hostedBy: "" });
const got = await downloadLevel(id);
if (!got) throw new Error(`No level ${id}`);
mkdirSync(projectPath("test/levels"), { recursive: true });
writeFileSync(projectPath(`test/levels/${id}.txt`), got.data);
writeFileSync(projectPath(`test/levels/${id}.json`), JSON.stringify({ ...got.level, capacity: got.capacity }, null, 1) + "\n");
console.log(`${got.level.name} by ${got.level.author}: ${got.data.length} chars, song ${JSON.stringify(got.level.song)}`);
