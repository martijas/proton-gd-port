// What the game remembers.
//
// One object under one key. The catalog replaces `localStorage` wholesale with
// a store it keeps per account on its own side, so a plain write here *is* the
// save — there is no sync layer to build and no API to call. The per-game cap
// is 6 MB and this is a few kilobytes, but the store still refuses anything
// absurd rather than risk wedging the quota.

import type { OnlineLevel } from "../online/api";
import type { IconChoice } from "../render/player";
import { DEFAULT_ICONS } from "../render/player";

export const SAVE_KEY = "gd:save";

/**
 * How many online levels the saved list keeps. The game keeps every level it
 * downloads; this keeps the description of each, not its data, and stops
 * where the per-game quota would start to matter. [guess]
 */
export const SAVED_LEVELS_MAX = 100;

/** One level's history. Percentages are 0–100. */
export interface LevelProgress {
  best: number;
  practiceBest: number;
  attempts: number;
  completions: number;
  /**
   * The three secret coins, by the coin's own number (object key 12):
   * `coins[0]` is coin 1. Set by a completion outside practice.
   * [gdp GJBaseGameLayer::processItems :420676-420763; getCoinKey
   *  :269911-269930]
   */
  coins: [boolean, boolean, boolean];
  firstCompletedAt?: string;
}

export interface Settings {
  musicVolume: number;
  sfxVolume: number;
  showPercentage: boolean;
  showProgressBar: boolean;
  autoRetry: boolean;
  /** Which sprite sheets load, as the game's Low, Medium and High: sd, hd and uhd. */
  textureQuality: TextureQuality;
  particles: boolean;
  shaders: boolean;
  /** Whether the menus play their loop. [gdp OptionsLayer::onMenuMusic, gv 0122 inverted] */
  menuMusic: boolean;
}

export type TextureQuality = "auto" | "low" | "medium" | "high";

/** The order the arrows step through. [gdp VideoOptionsLayer::updateTextureQuality :364084] */
export const TEXTURE_QUALITIES: readonly TextureQuality[] = ["auto", "low", "medium", "high"];

/** The sheet resolution each quality loads. Auto uses the sharpest sheets. */
export const TEXTURE_RES: Record<TextureQuality, "sd" | "hd" | "uhd"> = { auto: "uhd", low: "sd", medium: "hd", high: "uhd" };

export interface PlayerLook {
  icons: IconChoice;
  /** Indices into the game's own colour table, not RGB. */
  colour1: number;
  colour2: number;
  glow: boolean;
}

/** Counts nothing in `levels` can give back. */
export interface Totals {
  /**
   * Every jump the game counts — a cube, ball or robot leaving the ground,
   * and every orb taken — added at each death and finish; eleven
   * achievements count it. [gdp PlayLayer::commitJumps :92555-92562]
   */
  jumps: number;
  /**
   * Whether a normal-mode run has ever died at 95 to 99 %, which one
   * achievement is for. `levels` keeps only the best, which a completion
   * turns into 100. [gdp GameManager::reportPercentageForLevel :116839-116843]
   */
  nearMiss: boolean;
  /**
   * Icons destroyed by tapping them on the main menu, the game's stat 9; six
   * achievements count it. [gdp MenuGameLayer::destroyPlayer :237553;
   *  GameStatsManager::checkAchievement case 9 :351820]
   */
  menuKills: number;
  /**
   * Mana orbs earned, the game's stat 14, which the reward counter shows.
   * −1 in a save from before it was kept, until the game counts it up from
   * the levels' bests. [gdp GameStatsManager::awardCurrencyForLevel
   *  (incrementStat "14")]
   */
  orbs: number;
  /**
   * Achievements earned by something that happened once rather than by a
   * count: tapping cube 55 or cube 50 on the menu.
   * [gdp MenuGameLayer::ccTouchBegan :237637-237655]
   */
  earned: string[];
}

export interface SaveV1 {
  version: 1;
  createdAt: string;
  updatedAt: string;
  levels: Record<string, LevelProgress>;
  /**
   * Online levels' progress, by their server id. Kept apart from `levels`
   * because the two sets of ids overlap (online level 3001 is not The
   * Challenge), and because the totals and unlocks read `levels` as the
   * official set. A user coin lands in `coins` here and is no secret coin.
   */
  online: Record<string, LevelProgress>;
  /** The online levels played or downloaded, newest first, as the Saved tile lists them. */
  savedLevels: OnlineLevel[];
  player: PlayerLook;
  settings: Settings;
  totals: Totals;
}

export function emptyProgress(): LevelProgress {
  return { best: 0, practiceBest: 0, attempts: 0, completions: 0, coins: [false, false, false] };
}

export function defaultSettings(): Settings {
  return {
    musicVolume: 1,
    sfxVolume: 1,
    // A fresh game shows neither. [gdp GameManager::firstLoad :114397-114426:
    //  +668, the bar, = 0; gv 0040, the percentage, never set]
    showPercentage: false,
    showProgressBar: false,
    autoRetry: true,
    textureQuality: "high",
    particles: true,
    shaders: true,
    menuMusic: true,
  };
}

export function defaultSave(): SaveV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    levels: {},
    online: {},
    savedLevels: [],
    // The game's own starting colours: 0 is the first swatch, 3 the fourth.
    player: { icons: { ...DEFAULT_ICONS }, colour1: 0, colour2: 3, glow: false },
    settings: defaultSettings(),
    totals: { jumps: 0, nearMiss: false, menuKills: 0, orbs: 0, earned: [] },
  };
}

/** Every attempt, online levels' included, as the game's attempt stat counts them. */
export function totalAttempts(save: SaveV1): number {
  let total = 0;
  for (const progress of Object.values(save.levels)) total += progress.attempts;
  for (const progress of Object.values(save.online)) total += progress.attempts;
  return total;
}

/**
 * Stars and coins are *not* stored: they are counted from `levels` crossed with
 * what the game says each level awards. A total that is derived cannot drift
 * from the levels that produced it, and a corrupt one heals on the next load.
 */
export function totalStars(save: SaveV1, starsFor: (levelId: number) => number): number {
  let total = 0;
  for (const [id, progress] of Object.entries(save.levels)) {
    if (progress.completions > 0) total += starsFor(Number(id));
  }
  return total;
}

export function totalCoins(save: SaveV1): number {
  let total = 0;
  for (const progress of Object.values(save.levels)) {
    for (const got of progress.coins) if (got) total++;
  }
  return total;
}
