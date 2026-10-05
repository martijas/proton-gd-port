// The online demo levels: extreme demons from the online servers, as the last
// pages of the level select. Each level ships inside the bundle so it plays
// without the online servers; only its song comes from them. Their progress is
// kept with the online levels', by server id. The autoplayer's solves of them
// are in test/macros, where there is one.

import { loadLevel } from "../level/decode";
import type { Level } from "../level/types";

export interface DemoLevel {
  id: number;
  name: string;
  author: string;
  songId: number;
  song: string;
  artist: string;
  stars: number;
}

export const DEMO_LEVELS: readonly DemoLevel[] = [
  { id: 10565740, name: "Bloodbath", author: "Riot", songId: 467339, song: "At the Speed of Light", artist: "Dimrain47", stars: 10 },
  { id: 127323087, name: "Society", author: "Neomarbilan", songId: 1569886, song: "Pathetic - Society (Remix)", artist: "HelliXScream", stars: 10 },
  { id: 149992717, name: "GRIEF", author: "IcEDCave", songId: 482872, song: "KzX - Stalemate", artist: "Kayoszx", stars: 10 },
];

/** Each level's data and its capacity string, loaded only when it is played. */
const FILES: Record<number, () => Promise<[{ default: string }, { default: { capacity: string } }]>> = {
  10565740: () => Promise.all([import("../../test/levels/10565740.txt?raw"), import("../../test/levels/10565740.json")]),
  127323087: () => Promise.all([import("../../test/levels/127323087.txt?raw"), import("../../test/levels/127323087.json")]),
  149992717: () => Promise.all([import("../../test/levels/149992717.txt?raw"), import("../../test/levels/149992717.json")]),
};

export function demoLevel(id: number): DemoLevel | undefined {
  return DEMO_LEVELS.find((l) => l.id === id);
}

export async function loadDemoLevel(id: number): Promise<Level> {
  const files = FILES[id];
  if (!files) throw new Error(`No demo level ${id}`);
  const [data, info] = await files();
  const level = await loadLevel(data.default);
  return { ...level, capacity: info.default.capacity };
}
