/// <reference types="vite/client" />
import { loadLevel } from "../level/decode";
import type { Level } from "../level/types";

export interface OfficialLevel {
  id: number;
  name: string;
  /** Its capacity string, as the game's own table gives it (Level.capacity). */
  capacity: string;
}

/**
 * Ids match Resources/levels/<id>.txt in the real install. 3001 is The
 * Challenge (vault); 5001–5004 are the 2.2 Tower platformer floors in the
 * order the game unlocks them (The Tower → The Sewers → The Cellar → The
 * Secret Hollow; "The Map" is a 2.21 button, not a level file). The
 * capacity strings are LevelTools::getLevel's, the same set the 2.2074 exe
 * carries (file offsets 0x58e1b8-0x58e7a0): up to Deadlocked and The
 * Challenge the old form of sixteen, which marks a level made before 2.0's
 * layers.
 * [LevelTools::getLevel :120696-121075]
 */
export const OFFICIAL_LEVELS: readonly OfficialLevel[] = [
  { id: 1, name: "Stereo Madness", capacity: "29_98_29_40_29_29_29_29_29_29_177_29_73_29_29_29" },
  { id: 2, name: "Back On Track", capacity: "29_54_29_40_29_29_29_29_29_29_98_29_54_29_29_29" },
  { id: 3, name: "Polargeist", capacity: "29_98_29_40_29_29_29_29_29_29_29_29_98_29_29_29" },
  { id: 4, name: "Dry Out", capacity: "29_73_29_40_29_29_29_29_29_29_73_29_73_29_29_29" },
  { id: 5, name: "Base After Base", capacity: "29_73_29_40_29_29_29_29_29_29_98_29_73_29_29_29" },
  { id: 6, name: "Can't Let Go", capacity: "29_73_29_40_29_29_29_29_29_29_29_29_73_29_29_29" },
  { id: 7, name: "Jumper", capacity: "29_98_29_40_29_29_29_29_29_29_98_29_98_29_29_29" },
  { id: 8, name: "Time Machine", capacity: "29_132_29_40_29_29_29_29_29_29_73_29_98_29_29_29" },
  { id: 9, name: "Cycles", capacity: "29_98_29_40_29_29_29_40_29_29_98_29_98_29_29_29" },
  { id: 10, name: "xStep", capacity: "29_132_29_40_29_29_29_54_29_29_132_29_73_29_29_29" },
  { id: 11, name: "Clutterfunk", capacity: "29_237_29_40_29_29_29_73_29_29_29_29_98_29_29_29" },
  { id: 12, name: "Theory of Everything", capacity: "29_237_29_54_29_29_29_73_29_29_132_29_132_29_29_29" },
  { id: 13, name: "Electroman Adventures", capacity: "29_237_29_40_29_29_29_98_29_29_98_29_132_29_29_29" },
  { id: 14, name: "Clubstep", capacity: "29_237_29_54_29_29_29_132_29_29_98_29_132_29_29_29" },
  { id: 15, name: "Electrodynamix", capacity: "29_237_98_40_29_29_29_237_29_29_98_73_177_29_29_29" },
  { id: 16, name: "Hexagon Force", capacity: "29_317_73_73_29_29_54_132_29_29_237_132_177_29_29_29" },
  { id: 17, name: "Blast Processing", capacity: "29_237_29_73_29_29_98_132_29_29_566_54_132_29_29_29" },
  { id: 18, name: "Theory of Everything 2", capacity: "29_317_40_54_29_40_132_132_29_29_424_98_237_29_29_29" },
  { id: 19, name: "Geometrical Dominator", capacity: "29_424_132_40_29_29_566_132_29_29_756_237_132_29_73_29" },
  { id: 20, name: "Deadlocked", capacity: "29_317_73_73_29_29_317_424_73_29_566_317_177_29_132_54" },
  {
    id: 21,
    name: "Fingerdash",
    capacity:
      "40_630_195_48_0_0_210_114_0_0_572_247_97_0_0_53_466_135_0_459_276_71_448_0_101_88_101_0_0_0_0_0_0_0_0_0_0_0_0_0_0_" +
      "0_0_0_0_0_0_0_0_0_0_0_0_0_0",
  },
  { id: 22, name: "Dash", capacity: "24,340,52,244,54,1335,56,356,58,510,60,1257" },
  { id: 3001, name: "The Challenge", capacity: "73_237_29_40_29_29_237_98_29_29_237_237_132_29_29_29" },
  { id: 5001, name: "The Tower", capacity: "1,210,25,209,56,310,58,250,62,249" },
  { id: 5002, name: "The Sewers", capacity: "50,366,52,332,54,408" },
  { id: 5003, name: "The Cellar", capacity: "50,206,52,396,54,682" },
  { id: 5004, name: "The Secret Hollow", capacity: "52,505,54,1104,56,556,58,368" },
];

/** The capacity string the game's table gives an official level, if it has one. */
export function officialCapacity(id: number): string | undefined {
  return OFFICIAL_LEVELS.find((l) => l.id === id)?.capacity;
}

/** Dev reads straight from the install (vite.config.ts); the build ships copies under assets/. */
export function levelUrl(id: number): string {
  return import.meta.env.DEV ? `/__gd/resources/levels/${id}.txt` : `assets/levels/${id}.txt`;
}

export async function fetchLevel(id: number): Promise<Level> {
  const res = await fetch(levelUrl(id));
  if (!res.ok) throw new Error(`Level ${id} could not be loaded (${res.status}).`);
  // The files are ASCII base64 (some with a trailing NUL); latin1 keeps every byte one char.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const raw = new TextDecoder("latin1").decode(bytes);
  return { ...(await loadLevel(raw)), officialId: id, capacity: officialCapacity(id) };
}
