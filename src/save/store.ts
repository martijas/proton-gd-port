// Reading and writing the save, and never losing it to a bad value.
//
// Two rules. Nothing here throws: a missing, truncated, mistyped or
// from-the-future save yields a fresh one rather than a broken game, and the
// unreadable text is kept aside once so it can be looked at. And every field is
// merged against the defaults, so a save written by an older version gains the
// new fields and one written by a newer version loses only what this version
// does not understand.

import type { OnlineLevel, OnlineSong } from "../online/api";
import {
  defaultSave,
  emptyProgress,
  SAVE_KEY,
  SAVED_LEVELS_MAX,
  TEXTURE_QUALITIES,
  type LevelProgress,
  type SaveV1,
  type Settings,
  type TextureQuality,
} from "./schema";

/** The slice of `Storage` this needs, so a test can hand it a plain object. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A save bigger than this is a bug, and writing it risks the per-game quota. */
const MAX_BYTES = 512 * 1024;
const WRITE_DELAY_MS = 1000;
const CORRUPT_KEY = `${SAVE_KEY}:unreadable`;
/** The official platformer levels, whose deaths the game keeps no percentage for. */
const TOWER_FLOORS: ReadonlySet<number> = new Set([5001, 5002, 5003, 5004]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** A save from before the three qualities kept only `lowQuality`, which loaded the hd sheets. */
function quality(raw: Record<string, unknown>, fallback: TextureQuality): TextureQuality {
  const q = raw.textureQuality;
  if (typeof q === "string" && (TEXTURE_QUALITIES as readonly string[]).includes(q)) return q as TextureQuality;
  if (raw.lowQuality === true) return "medium";
  return fallback;
}

function mergeSettings(raw: unknown, base: Settings): Settings {
  if (!isObject(raw)) return base;
  return {
    musicVolume: num(raw.musicVolume, base.musicVolume, 0, 1),
    sfxVolume: num(raw.sfxVolume, base.sfxVolume, 0, 1),
    showPercentage: bool(raw.showPercentage, base.showPercentage),
    showProgressBar: bool(raw.showProgressBar, base.showProgressBar),
    autoRetry: bool(raw.autoRetry, base.autoRetry),
    textureQuality: quality(raw, base.textureQuality),
    particles: bool(raw.particles, base.particles),
    shaders: bool(raw.shaders, base.shaders),
    menuMusic: bool(raw.menuMusic, base.menuMusic),
    orbGuide: bool(raw.orbGuide, base.orbGuide),
    disablePortalGuide: bool(raw.disablePortalGuide, base.disablePortalGuide),
  };
}

function mergeProgress(raw: unknown): LevelProgress {
  const base = emptyProgress();
  if (!isObject(raw)) return base;
  const coins = Array.isArray(raw.coins) ? raw.coins : [];
  return {
    best: num(raw.best, base.best, 0, 100),
    practiceBest: num(raw.practiceBest, base.practiceBest, 0, 100),
    attempts: Math.trunc(num(raw.attempts, base.attempts, 0)),
    completions: Math.trunc(num(raw.completions, base.completions, 0)),
    coins: [coins[0] === true, coins[1] === true, coins[2] === true],
    firstCompletedAt: typeof raw.firstCompletedAt === "string" ? raw.firstCompletedAt : undefined,
  };
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function mergeSong(raw: unknown): OnlineSong {
  if (isObject(raw) && raw.kind === "custom") {
    return {
      kind: "custom",
      id: Math.trunc(num(raw.id, 0, 0)),
      name: text(raw.name, 60),
      artist: text(raw.artist, 40),
      available: bool(raw.available, true),
    };
  }
  return { kind: "official", index: Math.trunc(num(isObject(raw) ? raw.index : 0, 0, 0, 100)) };
}

/** A saved online level's description, or null when it is not one. */
function mergeOnlineLevel(raw: unknown): OnlineLevel | null {
  if (!isObject(raw)) return null;
  const id = Math.trunc(num(raw.id, 0));
  if (id <= 0) return null;
  return {
    id,
    name: text(raw.name, 40) || "Unnamed",
    description: text(raw.description, 300),
    author: text(raw.author, 20),
    face: Math.trunc(num(raw.face, 0, -1, 10)),
    stars: Math.trunc(num(raw.stars, 0, 0, 100)),
    demon: bool(raw.demon, false),
    featured: bool(raw.featured, false),
    epic: Math.trunc(num(raw.epic, 0, 0, 3)),
    downloads: Math.trunc(num(raw.downloads, 0, 0)),
    likes: Math.trunc(num(raw.likes, 0)),
    length: Math.trunc(num(raw.length, 0, 0, 5)),
    coins: Math.trunc(num(raw.coins, 0, 0, 3)),
    verifiedCoins: bool(raw.verifiedCoins, false),
    twoPlayer: bool(raw.twoPlayer, false),
    objects: Math.trunc(num(raw.objects, 0, 0)),
    version: Math.trunc(num(raw.version, 0, 0)),
    song: mergeSong(raw.song),
  };
}

/**
 * Anything at all, turned into a save. The version is a chain: each step takes
 * the previous shape to the next, and the merge at the end fills in whatever is
 * still missing.
 */
export function migrate(raw: unknown): SaveV1 {
  const base = defaultSave();
  if (!isObject(raw)) return base;
  // A value from the future is not guessed at — the fields this version
  // understands are taken and the rest dropped.
  const version = Math.trunc(num(raw.version, 0, 0));
  const settings = mergeSettings(raw.settings, base.settings);
  // Version 2: nothing in a version-1 save could turn the bar or the
  // percentage on — an early build did, by default — so both go back to the
  // game's default, off. From version 2 they are the player's own choice.
  if (version < 2) {
    settings.showProgressBar = base.settings.showProgressBar;
    settings.showPercentage = base.settings.showPercentage;
  }
  const player = isObject(raw.player) ? raw.player : {};
  const icons = isObject(player.icons) ? player.icons : {};
  const levels: Record<string, LevelProgress> = {};
  if (isObject(raw.levels)) {
    for (const [id, progress] of Object.entries(raw.levels)) {
      if (!/^\d+$/.test(id)) continue;
      levels[id] = mergeProgress(progress);
    }
  }
  const online: Record<string, LevelProgress> = {};
  if (isObject(raw.online)) {
    for (const [id, progress] of Object.entries(raw.online)) {
      if (!/^\d+$/.test(id)) continue;
      online[id] = mergeProgress(progress);
    }
  }
  const savedLevels: OnlineLevel[] = [];
  if (Array.isArray(raw.savedLevels)) {
    for (const entry of raw.savedLevels) {
      const level = mergeOnlineLevel(entry);
      if (level && !savedLevels.some((l) => l.id === level.id)) savedLevels.push(level);
      if (savedLevels.length >= SAVED_LEVELS_MAX) break;
    }
  }
  const mergedIcons = { ...base.player.icons };
  for (const kind of Object.keys(mergedIcons) as (keyof typeof mergedIcons)[]) {
    mergedIcons[kind] = Math.trunc(num(icons[kind], mergedIcons[kind], 1));
  }
  const totals = isObject(raw.totals) ? raw.totals : {};
  return {
    version: 2,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    levels,
    online,
    savedLevels,
    player: {
      icons: mergedIcons,
      colour1: Math.trunc(num(player.colour1, base.player.colour1, 0)),
      colour2: Math.trunc(num(player.colour2, base.player.colour2, 0)),
      glow: bool(player.glow, base.player.glow),
    },
    settings,
    totals: {
      jumps: Math.max(0, Math.trunc(num(totals.jumps, 0, 0))),
      // A save from before the flag was kept already shows such a death in a
      // normal best of 95 to 99 %. Not a tower floor's: this port once kept a
      // platformer death's percentage too, and the game reports none.
      // [gdp PlayLayer::destroyPlayer :93205-93211 skips :93240-93254]
      nearMiss:
        bool(totals.nearMiss, false) ||
        Object.entries(levels).some(([id, l]) => !TOWER_FLOORS.has(Number(id)) && l.best >= 95 && l.best < 100),
      menuKills: Math.max(0, Math.trunc(num(totals.menuKills, 0, 0))),
      orbs: Math.trunc(num(totals.orbs, -1, -1)),
      earned: Array.isArray(totals.earned)
        ? [...new Set(totals.earned.filter((id): id is string => typeof id === "string" && /^geometry\.ach\.[\w]+$/.test(id)))].slice(0, 64)
        : [],
    },
  };
}

export class SaveStore {
  private value: SaveV1;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly storage: KeyValueStore) {
    this.value = this.read();
  }

  get(): SaveV1 {
    return this.value;
  }

  /** The stored progress for a level, or a fresh one. Never undefined. */
  level(id: number): LevelProgress {
    return this.value.levels[String(id)] ?? emptyProgress();
  }

  /** The same for an online level, by its server id. */
  onlineLevel(id: number): LevelProgress {
    return this.value.online[String(id)] ?? emptyProgress();
  }

  /** Whether an online level is on the saved list. */
  isSaved(id: number): boolean {
    return this.value.savedLevels.some((l) => l.id === id);
  }

  /**
   * Puts an online level at the top of the saved list, as downloading one
   * does in the game, with the description it has now. The oldest drops off
   * the end once the list is full.
   */
  saveOnlineLevel(level: OnlineLevel): void {
    this.set((save) => {
      const rest = save.savedLevels.filter((l) => l.id !== level.id);
      save.savedLevels = [level, ...rest].slice(0, SAVED_LEVELS_MAX);
    });
  }

  /** Takes a level off the saved list. Its progress stays, as the game's does. */
  forgetOnlineLevel(id: number): void {
    this.set((save) => {
      save.savedLevels = save.savedLevels.filter((l) => l.id !== id);
    });
  }

  /**
   * Changes the save. The mutation runs against the live object and the write
   * is debounced, so a level that records an attempt every restart does not
   * serialise the whole save each time.
   */
  set(mutate: (save: SaveV1) => void): void {
    mutate(this.value);
    this.value.updatedAt = new Date().toISOString();
    this.dirty = true;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
  }

  /**
   * Records an attempt and a new best, and returns whether the best moved.
   * `percent` is what the attempt leaves: a death's whole percentage, below
   * 100; 100 for a completion; 0 when the game keeps nothing (a run from a
   * start position, a platformer's death). A normal-mode death at 95 to 99 %
   * is noted for the one achievement it earns. A completion outside practice
   * also keeps the secret coins the run picked up, by their own number (1
   * to 3); anything else drops them, as the game does.
   * [gdp PlayLayer::destroyPlayer :93198-93254; levelComplete :92772-92848
   *  (processItems :420676-420763); GameManager::reportPercentageForLevel
   *  :116839-116843]
   */
  recordAttempt(id: number, percent: number, practice: boolean, coins: readonly number[] = [], online = false): boolean {
    let improved = false;
    this.set((save) => {
      const key = String(id);
      const table = online ? save.online : save.levels;
      const progress = table[key] ?? emptyProgress();
      progress.attempts++;
      const field = practice ? "practiceBest" : "best";
      if (percent > progress[field]) {
        progress[field] = percent;
        improved = true;
      }
      if (!practice && percent >= 95 && percent < 100) save.totals.nearMiss = true;
      if (!practice && percent >= 100) {
        progress.completions++;
        progress.firstCompletedAt ??= new Date().toISOString();
        for (const n of coins) if (n >= 1 && n <= 3) progress.coins[n - 1] = true;
      }
      table[key] = progress;
    });
    return improved;
  }

  /**
   * An icon destroyed on the main menu, and the one-off achievement it earned
   * when it was cube 55 or cube 50.
   */
  recordMenuKill(secret: string | null): void {
    this.set((save) => {
      save.totals.menuKills++;
      if (secret && !save.totals.earned.includes(secret)) save.totals.earned.push(secret);
    });
  }

  /** Writes now. Called on level end, on settings change, and on leaving. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const text = JSON.stringify(this.value);
      if (text.length > MAX_BYTES) {
        console.warn(`the save is ${text.length} bytes, which is too big to be right; not writing it`);
        return;
      }
      this.storage.setItem(SAVE_KEY, text);
    } catch {
      // A full or blocked store is the player's problem to see, not a crash.
    }
  }

  /** Back to a new save. The host's reset button ends up here. */
  reset(): void {
    this.value = defaultSave();
    this.dirty = true;
    this.flush();
    try {
      this.storage.removeItem(SAVE_KEY);
    } catch {
      // Nothing to do; the defaults are already in memory.
    }
  }

  private read(): SaveV1 {
    let text: string | null = null;
    try {
      text = this.storage.getItem(SAVE_KEY);
    } catch {
      return defaultSave();
    }
    if (text === null || text === "") return defaultSave();
    try {
      return migrate(JSON.parse(text));
    } catch {
      // Keep the unreadable text once so it can be looked at, and carry on.
      try {
        if (this.storage.getItem(CORRUPT_KEY) === null) this.storage.setItem(CORRUPT_KEY, text);
      } catch {
        // Not worth failing over.
      }
      console.warn("the saved progress could not be read; starting fresh");
      return defaultSave();
    }
  }
}
