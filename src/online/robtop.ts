// The game's own level servers, spoken to in their own format.
//
// Every request is the form the 2.2 client posts, sent to `serverBase()`
// (hostConfig.ts): RobTop's servers themselves, or a tunnel that passes the
// form on unchanged. The colon-separated replies are turned into the shapes
// api.ts hands the screens.

import type { Gauntlet, LevelPage, MapPack, OnlineLevel, OnlineSong } from "./api";
import { serverBase } from "./hostConfig";

/** A failure with a sentence a player can read. */
export class OnlineError extends Error {}

export const OFFLINE = "Couldn't reach the level servers. Check your connection and try again.";
const UNAVAILABLE = "Online levels aren't available right now.";

/** The 2.2 client's own common secret, sent with every request. */
const SECRET = "Wmfd2893gb7";
const TIMEOUT_MS = 15_000;
/** Big enough for any real level, small enough that a bad reply cannot fill memory. */
const MAX_LEVEL_CHARS = 40 * 1024 * 1024;

/** The endpoints the game reads from. A tunnel only needs to pass these on. */
export const ENDPOINTS = [
  "getGJLevels21.php",
  "downloadGJLevel22.php",
  "getGJMapPacks21.php",
  "getGJGauntlets21.php",
  "getGJSongInfo.php",
  "getGJUsers20.php",
] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/** The form a request sends, secret and versions included. */
export function formFor(params: Record<string, string | number>): URLSearchParams {
  const body = new URLSearchParams({ secret: SECRET, gameVersion: "22", binaryVersion: "42" });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  return body;
}

async function post(endpoint: Endpoint, params: Record<string, string | number>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${serverBase()}/${endpoint}`, {
      method: "POST",
      body: formFor(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OnlineError(OFFLINE);
  }
  const text = (await res.text().catch(() => "")).trim();
  if (!res.ok) throw new OnlineError(messageIn(text) ?? (res.status >= 500 ? OFFLINE : UNAVAILABLE));
  if (text.startsWith("<") || text.startsWith("error code") || text.startsWith("{")) throw new OnlineError(UNAVAILABLE);
  return text;
}

/** A tunnel's failure may carry a sentence of its own. */
function messageIn(text: string): string | null {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body.message === "string" && body.message ? body.message : null;
  } catch {
    return null;
  }
}

// --- parsing -----------------------------------------------------------------

/** `k:v:k:v…` into a map. */
export function pairs(text: string, sep = ":"): Map<string, string> {
  const parts = text.split(sep);
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i], parts[i + 1]);
  return out;
}

function int(v: string | undefined): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** The game's fonts are ASCII; anything else would draw as nothing. */
function printable(text: string, max: number): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function base64Text(v: string | undefined): string {
  if (!v) return "";
  try {
    const bin = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

type CustomSong = Extract<OnlineSong, { kind: "custom" }> & { url: string };

/** Key 43 to the face's number. */
const DEMON_FACE: Record<number, number> = { 3: 7, 4: 8, 0: 6, 2: 6, 5: 9, 6: 10 };

function faceOf(k: Map<string, string>): number {
  if (int(k.get("25")) === 1) return -1;
  if (int(k.get("17")) === 1) return DEMON_FACE[int(k.get("43"))] ?? 6;
  return Math.max(0, Math.min(5, Math.round(int(k.get("9")) / 10)));
}

function songFrom(k: Map<string, string>, songs: Map<number, OnlineSong>): OnlineSong {
  const custom = int(k.get("35"));
  if (custom > 0) return songs.get(custom) ?? { kind: "custom", id: custom, name: `Song ${custom}`, artist: "", available: true };
  return { kind: "official", index: int(k.get("12")) };
}

export function levelFrom(k: Map<string, string>, authors: Map<number, string>, songs: Map<number, OnlineSong>): OnlineLevel {
  return {
    id: int(k.get("1")),
    name: printable(k.get("2") ?? "", 40) || "Unnamed",
    description: printable(base64Text(k.get("3")), 300),
    author: authors.get(int(k.get("6"))) ?? "",
    face: faceOf(k),
    stars: int(k.get("18")),
    demon: int(k.get("17")) === 1,
    featured: int(k.get("19")) > 0,
    epic: Math.max(0, Math.min(3, int(k.get("42")))),
    downloads: int(k.get("10")),
    likes: int(k.get("14")),
    length: Math.max(0, Math.min(5, int(k.get("15")))),
    coins: Math.max(0, Math.min(3, int(k.get("37")))),
    verifiedCoins: int(k.get("38")) === 1,
    twoPlayer: int(k.get("31")) === 1,
    objects: int(k.get("45")),
    version: int(k.get("5")),
    song: songFrom(k, songs),
  };
}

/** `1~|~id~|~2~|~name~|~…`, joined by `~:~`. */
function parseSongs(section: string | undefined): Map<number, OnlineSong> {
  const out = new Map<number, OnlineSong>();
  if (!section) return out;
  for (const entry of section.split("~:~")) {
    const s = parseSong(entry);
    if (s) out.set(s.id, publicSong(s));
  }
  return out;
}

export function parseSong(entry: string): CustomSong | null {
  const k = pairs(entry, "~|~");
  const id = int(k.get("1"));
  if (id <= 0) return null;
  let url = "";
  try {
    url = decodeURIComponent(k.get("10") ?? "");
  } catch {
    /* left empty */
  }
  return {
    kind: "custom",
    id,
    name: printable(k.get("2") ?? "", 60) || `Song ${id}`,
    artist: printable(k.get("4") ?? "", 40),
    // Library songs always come from the library; a Newgrounds song with no
    // address cannot be fetched at all.
    available: id > 9_999_999 || (url !== "" && url !== "-"),
    url,
  };
}

function publicSong(s: CustomSong): OnlineSong {
  return { kind: "custom", id: s.id, name: s.name, artist: s.artist, available: s.available };
}

/** `playerID:name:accountID|…` */
function parseAuthors(section: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!section) return out;
  for (const entry of section.split("|")) {
    const [player, name] = entry.split(":");
    if (player) out.set(int(player), printable(name ?? "", 20));
  }
  return out;
}

/** A whole level list reply: levels, authors, songs, page. */
export function parseLevelPage(text: string, page: number): LevelPage {
  if (text === "" || /^-\d+$/.test(text)) return { levels: [], total: 0, page, perPage: 10 };
  const [levelSec, authorSec, songSec, pageSec] = text.split("#");
  const authors = parseAuthors(authorSec);
  const songs = parseSongs(songSec);
  const levels = (levelSec ?? "")
    .split("|")
    .filter(Boolean)
    .map((entry) => levelFrom(pairs(entry), authors, songs));
  const [total, , perPage] = (pageSec ?? "").split(":").map(int);
  return { levels, total: total || levels.length, page, perPage: perPage || 10 };
}

/** Map pack difficulty to the face's number. */
const PACK_FACE = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function parseMapPacks(text: string): { packs: MapPack[]; total: number; perPage: number } {
  if (/^-\d+$/.test(text)) return { packs: [], total: 0, perPage: 10 };
  const [packSec, pageSec] = text.split("#");
  const packs = (packSec ?? "")
    .split("|")
    .filter(Boolean)
    .map((entry) => {
      const k = pairs(entry);
      const rgb = (k.get("7") ?? "255,255,255").split(",").map((n) => Math.max(0, Math.min(255, int(n))));
      return {
        id: int(k.get("1")),
        name: printable(k.get("2") ?? "", 40),
        levels: (k.get("3") ?? "").split(",").map(int).filter((n) => n > 0),
        stars: int(k.get("4")),
        coins: int(k.get("5")),
        face: PACK_FACE[int(k.get("6"))] ?? 0,
        colour: [rgb[0] ?? 255, rgb[1] ?? 255, rgb[2] ?? 255] as [number, number, number],
      };
    });
  const [total, , perPage] = (pageSec ?? "").split(":").map(int);
  return { packs, total: total || packs.length, perPage: perPage || 10 };
}

export function parseGauntlets(text: string): Gauntlet[] {
  if (/^-\d+$/.test(text)) return [];
  return (text.split("#")[0] ?? "")
    .split("|")
    .filter(Boolean)
    .map((entry) => {
      const k = pairs(entry);
      return { id: int(k.get("1")), levels: (k.get("3") ?? "").split(",").map(int).filter((n) => n > 0) };
    })
    .filter((g) => g.id > 0);
}

// --- a short memory, so flipping pages back and forth costs nothing ------------

const memo = new Map<string, { until: number; value: Promise<unknown> }>();
const MEMO_KEEP = 200;

function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { until: Date.now() + ttlMs, value });
  value.catch(() => memo.delete(key));
  while (memo.size > MEMO_KEEP) memo.delete(memo.keys().next().value as string);
  return value;
}

// --- what api.ts calls -------------------------------------------------------

export interface Search {
  type: number;
  str: string;
  page: number;
  diff?: string;
  demonFilter?: number;
  len?: string;
  star?: boolean;
}

export function searchLevels(q: Search): Promise<LevelPage> {
  return remember(`list:${JSON.stringify(q)}`, 90_000, async () => {
    let str = q.str;
    // A player's levels are listed by player id; a name is looked up first.
    if (q.type === 5 && !/^\d+$/.test(str)) {
      const id = str.trim() ? await playerIdFor(str.trim()) : 0;
      if (!id) return { levels: [], total: 0, page: q.page, perPage: 10 };
      str = String(id);
    }
    const params: Record<string, string | number> = { type: q.type, str, page: q.page, total: 0 };
    if (q.diff) params.diff = q.diff;
    if (q.demonFilter) params.demonFilter = q.demonFilter;
    if (q.len) params.len = q.len;
    if (q.star) params.star = 1;
    return parseLevelPage(await post("getGJLevels21.php", params), q.page);
  });
}

/** The player id behind a name, or 0 when no one has it. Key 2 of the user search. */
function playerIdFor(name: string): Promise<number> {
  return remember(`player:${name.toLowerCase()}`, 60 * 60_000, async () => {
    const text = await post("getGJUsers20.php", { str: name, page: 0, total: 0 });
    if (/^-\d+$/.test(text) || text === "") return 0;
    return int(pairs(text.split("#")[0]?.split("|")[0] ?? "").get("2"));
  });
}

export interface RawDownload {
  level: OnlineLevel;
  /** The level string as the servers keep it: base64 of gzip. */
  data: string;
  /** Key 36, the capacity string the renderer reads batch sizes from. */
  capacity: string;
}

/** One level with its data, or null when there is no such level. */
export async function downloadLevel(id: number): Promise<RawDownload | null> {
  const text = await post("downloadGJLevel22.php", { levelID: id });
  if (/^-\d+$/.test(text) || text === "") return null;
  if (text.length > MAX_LEVEL_CHARS) throw new OnlineError("This level is too big to open.");
  const k = pairs(text.split("#")[0] ?? "");
  const data = k.get("4") ?? "";
  if (!data) return null;
  const custom = int(k.get("35"));
  const songs = new Map<number, OnlineSong>();
  if (custom > 0) {
    const info = await songInfo(custom).catch(() => null);
    if (info) songs.set(custom, publicSong(info));
    else songs.set(custom, { kind: "custom", id: custom, name: `Song ${custom}`, artist: "", available: custom > 9_999_999 });
  }
  const authorName = await authorFor(int(k.get("6")), printable(k.get("2") ?? "", 40));
  const authors = new Map<number, string>([[int(k.get("6")), authorName]]);
  return { level: levelFrom(k, authors, songs), data, capacity: k.get("36") ?? "" };
}

/**
 * The download reply carries the author's player id but not their name. A
 * search for the player's levels finds it in the reply's author section; when
 * it does not, the level simply shows no author.
 */
async function authorFor(playerId: number, name: string): Promise<string> {
  if (playerId <= 0 || !name) return "";
  try {
    const page = await post("getGJLevels21.php", { type: 5, str: playerId, page: 0, total: 0 });
    return parseAuthors(page.split("#")[1]).get(playerId) ?? "";
  } catch {
    return "";
  }
}

export function songInfo(id: number): Promise<CustomSong | null> {
  return remember(`song:${id}`, 6 * 60 * 60_000, async () => {
    const text = await post("getGJSongInfo.php", { songID: id });
    if (/^-\d+$/.test(text)) return null;
    return parseSong(text);
  });
}

export function mapPacks(page: number): Promise<{ packs: MapPack[]; total: number; perPage: number }> {
  return remember(`packs:${page}`, 10 * 60_000, async () => parseMapPacks(await post("getGJMapPacks21.php", { page })));
}

export function gauntlets(): Promise<Gauntlet[]> {
  return remember("gauntlets", 30 * 60_000, async () => parseGauntlets(await post("getGJGauntlets21.php", { special: 1 })));
}

// --- audio -------------------------------------------------------------------

const CDN = "https://geometrydashfiles.b-cdn.net";
/** The only hosts a song or effect is ever fetched from. */
export const AUDIO_HOSTS = [/(^|\.)ngfiles\.com$/, /^geometrydashfiles\.b-cdn\.net$/, /^geometrydashcontent\.b-cdn\.net$/];

/** Where a sound is fetched from: straight from its host when direct, through the tunnel otherwise. */
export function audioUrl(raw: string, direct: boolean, base = serverBase()): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.protocol = "https:";
  if (!AUDIO_HOSTS.some((re) => re.test(url.hostname))) return null;
  return direct ? url.toString() : `${base}/audio?url=${encodeURIComponent(url.toString())}`;
}

/** The music library's CDN for library ids, the address the servers give for a Newgrounds one. */
export async function songSource(id: number): Promise<string | null> {
  if (id > 9_999_999) return `${CDN}/music/${id}.ogg`;
  const info = await songInfo(id).catch(() => null);
  return info?.available ? info.url : null;
}

export function sfxSource(id: number): string {
  return `${CDN}/sfx/s${id}.ogg`;
}
