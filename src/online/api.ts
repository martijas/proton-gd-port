// Online levels: the shapes the screens use, and the calls that fetch them.
//
// robtop.ts speaks to the game's own level servers (or the tunnel the host
// config names) and parses their replies into these shapes. Every failure
// becomes an `OnlineError` whose message can be shown as it is.

import { loadLevel } from "../level/decode";
import type { Level } from "../level/types";
import { hostConfig } from "./hostConfig";
import * as robtop from "./robtop";
import { OnlineError } from "./robtop";

export { OnlineError };

export type OnlineSong =
  | { kind: "official"; index: number }
  | { kind: "custom"; id: number; name: string; artist: string; available: boolean };

export interface OnlineLevel {
  id: number;
  name: string;
  description: string;
  author: string;
  /** -1 auto, 0 unrated, 1-5 easy to insane, 6 hard, 7 easy, 8 medium, 9 insane, 10 extreme demon. */
  face: number;
  stars: number;
  demon: boolean;
  featured: boolean;
  /** 0 none, 1 epic, 2 legendary, 3 mythic. */
  epic: number;
  downloads: number;
  likes: number;
  /** 0 tiny, 1 short, 2 medium, 3 long, 4 XL, 5 platformer. */
  length: number;
  coins: number;
  verifiedCoins: boolean;
  twoPlayer: boolean;
  objects: number;
  version: number;
  song: OnlineSong;
}

export interface LevelPage {
  levels: OnlineLevel[];
  total: number;
  page: number;
  perPage: number;
}

export interface MapPack {
  id: number;
  name: string;
  levels: number[];
  stars: number;
  coins: number;
  face: number;
  colour: [number, number, number];
}

export interface Gauntlet {
  id: number;
  levels: number[];
}

/** The list kinds the search page and the creator tiles open. */
export const LIST_TYPE = {
  search: 0,
  downloads: 1,
  likes: 2,
  trending: 3,
  recent: 4,
  byUser: 5,
  featured: 6,
  magic: 7,
  ids: 10,
  awarded: 11,
  hallOfFame: 16,
  sent: 27,
} as const;

export interface LevelQuery {
  type: number;
  str?: string;
  /** Comma list of -1 unrated, -2 demon, -3 auto, 1-5. */
  diff?: string;
  /** With diff -2: 1-5 easy to extreme demons, 0 any. */
  demonFilter?: number;
  /** Comma list of 0-5. */
  len?: string;
  /** Only levels that award stars. */
  star?: boolean;
}

export function searchLevels(query: LevelQuery, page: number): Promise<LevelPage> {
  // Type 10 is a list of ids; every other type is a name or player search.
  const raw = query.str ?? "";
  const str = query.type === LIST_TYPE.ids ? raw.replace(/[^0-9,]/g, "").slice(0, 400) : raw.replace(/[^\x20-\x7e]/g, "").slice(0, 40);
  return robtop.searchLevels({ ...query, str, page });
}

export function mapPacks(page: number): Promise<{ packs: MapPack[]; total: number; perPage: number }> {
  return robtop.mapPacks(page);
}

export function gauntlets(): Promise<Gauntlet[]> {
  return robtop.gauntlets();
}

export interface Downloaded {
  info: OnlineLevel;
  level: Level;
}

/** The last few levels played, decoded, so a retry from the list does not download again. */
const recent = new Map<number, Promise<Downloaded>>();
const RECENT_KEEP = 3;

/**
 * Downloads and decodes a level. -1, -2 and -3 are today's daily, weekly and
 * event levels; the result carries the level's real id.
 */
export function downloadLevel(id: number): Promise<Downloaded> {
  const have = recent.get(id);
  if (have) return have;
  const job = (async () => {
    const reply = await robtop.downloadLevel(id);
    if (!reply) {
      throw new OnlineError(id < 0 ? "There's no level here right now. Check back later." : "That level couldn't be found.");
    }
    let level: Level;
    try {
      level = await loadLevel(reply.data);
    } catch {
      throw new OnlineError("This level couldn't be opened.");
    }
    if (level.objects.length === 0) throw new OnlineError("This level is empty.");
    return { info: reply.level, level: { ...level, capacity: reply.capacity || undefined } };
  })();
  // Today's levels change, so only a real id is kept.
  if (id > 0) {
    recent.set(id, job);
    job.catch(() => recent.delete(id));
    while (recent.size > RECENT_KEEP) recent.delete(recent.keys().next().value as number);
  }
  return job;
}

/**
 * Where an online level's custom song or a library sound comes from when the
 * build did not ship it. Null when it can't be fetched at all.
 */
export async function songUrl(id: number): Promise<string | null> {
  const source = await robtop.songSource(id);
  return source ? robtop.audioUrl(source, hostConfig().server.mode === "direct") : null;
}

export async function sfxUrl(id: number): Promise<string | null> {
  return robtop.audioUrl(robtop.sfxSource(id), hostConfig().server.mode === "direct");
}

// --- how a level is described --------------------------------------------------

const FACE_NAMES: Record<number, string> = {
  [-1]: "Auto",
  0: "N/A",
  1: "Easy",
  2: "Normal",
  3: "Hard",
  4: "Harder",
  5: "Insane",
  6: "Hard Demon",
  7: "Easy Demon",
  8: "Medium Demon",
  9: "Insane Demon",
  10: "Extreme Demon",
};

export function faceName(face: number): string {
  return FACE_NAMES[face] ?? "N/A";
}

/** The difficulty face's frame on the gameplay sheet. */
export function faceFrame(face: number): string {
  if (face < 0) return "difficulty_auto_btn_001.png";
  return `difficulty_${String(Math.min(10, face)).padStart(2, "0")}_btn_001.png`;
}

const LENGTH_NAMES = ["Tiny", "Short", "Medium", "Long", "XL", "Plat."];

export function lengthName(length: number): string {
  return LENGTH_NAMES[length] ?? "Tiny";
}

/** 1234567 as "1.2M", the way the browser rows fit their numbers. */
export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
