// What the player has earned the right to wear.
//
// The game unlocks icons and colours three ways: a handful come free, most are
// the reward for an achievement, and the rest are bought or found in parts of
// the game this port does not have — the shop, the chests, the vaults. The
// first two can be decided here from the save and the achievement table the
// build read out of the binary. The third is reported as exactly that, rather
// than as locked behind something that will never happen or as unlocked for
// nothing.
//
// The achievement conditions themselves are only partly known. The check
// routine gives every one a stat and a count; what a stat *is* comes from the
// achievement's own name — `stars05` counts stars, `coins19` secret coins —
// and this port can only count what its save records. Stars, secret coins,
// demons, jumps, attempts, each level's best in either mode and its coins,
// and a normal-mode death at 95 to 99 %, it can. Online levels, map packs,
// user coins, diamonds and the social ones, it cannot, and those come back
// as "not decidable here" rather than as false.
// [gdp GameManager::isIconUnlocked, gd-ida-decomp.cpp:116305-116334 for the
//  free set; isColorUnlocked :116440-116466; the rewards and thresholds are
//  in strings.json, see tools/assets/strings.ts]

import type { IconKind } from "../assets/iconTypes";
import type { AchievementFacts } from "../assets/stringTypes";
import { totalAttempts, totalCoins, type LevelProgress, type SaveV1 } from "./schema";

export type RewardKind = IconKind | "colour1" | "colour2" | "death" | "special";

export interface Reward {
  kind: RewardKind;
  index: number;
}

/** The game's stat numbers, as `checkAchievement` switches on them. */
const STAT = { jumps: 1, attempts: 2, demons: 5, stars: 6, secretCoins: 8, menuKills: 9 } as const;

/**
 * The achievements for tapping one particular cube on the main menu: cube 55
 * and cube 50, full size, on foot. [gdp MenuGameLayer::ccTouchBegan
 *  :237630-237655]
 */
export const MENU_CUBE_SECRETS: Readonly<Record<number, string>> = {
  55: "geometry.ach.secret11",
  50: "geometry.ach.secret12",
};

/**
 * The achievement for a normal-mode death at 95 to 99 %, which the save
 * keeps as `totals.nearMiss`. [gdp GameManager::reportPercentageForLevel
 *  :116839-116843]
 */
const NEAR_MISS = "geometry.ach.special01";

/**
 * The three demons whose coins earn an achievement of their own: Clubstep,
 * Theory of Everything 2 and Deadlocked. [gdp
 *  GameStatsManager::checkCoinAchievement :342748-342789]
 */
const DEMON_COINS: Readonly<Record<string, number>> = {
  "geometry.ach.demoncoin01": 14,
  "geometry.ach.demoncoin02": 18,
  "geometry.ach.demoncoin03": 20,
};

/**
 * The reward strings use the game's internal names for the modes: `icon` is
 * the cube, `bird` the UFO, `dart` the wave. `color` and `color2` are the two
 * colour slots, which unlock separately.
 */
const REWARD_KINDS: Record<string, RewardKind> = {
  icon: "cube",
  ship: "ship",
  ball: "ball",
  bird: "ufo",
  dart: "wave",
  robot: "robot",
  spider: "spider",
  swing: "swing",
  jetpack: "jetpack",
  color: "colour1",
  color2: "colour2",
  death: "death",
  special: "special",
};

export function parseReward(text: string | null | undefined): Reward | null {
  if (!text) return null;
  const m = /^([a-z0-9]+)_(\d+)$/.exec(text.trim());
  if (!m) return null;
  const kind = REWARD_KINDS[m[1]];
  if (!kind) return null;
  return { kind, index: Number(m[2]) };
}

/** What the save can say about how far the player has got. */
export interface Progress {
  stars: number;
  secretCoins: number;
  demons: number;
  attempts: number;
  jumps: number;
  /** Level ids completed at 100 in normal mode. */
  completed: ReadonlySet<number>;
  /** Level ids completed at 100 in practice. */
  practised: ReadonlySet<number>;
  /** Every level the save has seen, for the achievements about one level. */
  levels: ReadonlyMap<number, LevelProgress>;
  /** A normal-mode run has died at 95 to 99 %. */
  nearMiss: boolean;
  /** Icons destroyed on the main menu. */
  menuKills: number;
  /** Achievements earned once by an event, by id. */
  earned: ReadonlySet<string>;
}

function menuSecret(id: string): boolean {
  return Object.values(MENU_CUBE_SECRETS).includes(id);
}

export function progressOf(
  save: SaveV1,
  starsFor: (levelId: number) => number,
  isDemon: (levelId: number) => boolean,
): Progress {
  const completed = new Set<number>();
  const practised = new Set<number>();
  const levels = new Map<number, LevelProgress>();
  let stars = 0;
  let demons = 0;
  for (const [key, progress] of Object.entries(save.levels)) {
    const id = Number(key);
    levels.set(id, progress);
    if (progress.completions > 0) {
      completed.add(id);
      stars += starsFor(id);
      if (isDemon(id)) demons++;
    }
    if (progress.practiceBest >= 100) practised.add(id);
  }
  return {
    stars,
    secretCoins: totalCoins(save),
    demons,
    attempts: totalAttempts(save),
    jumps: save.totals.jumps,
    completed,
    practised,
    levels,
    nearMiss: save.totals.nearMiss,
    menuKills: save.totals.menuKills,
    earned: new Set(save.totals.earned),
  };
}

/**
 * An achievement the game reports about one level rather than from a stat:
 * finishing it (`levelNNb`, and `tower0N` for a floor), finishing it in
 * practice (`levelNNa`), or holding all three of its coins (`demoncoin01`-`03`
 * and `tower0NCoin`). Its progress is the best percentage in that mode, or
 * the coins over three, as the game reports them.
 * [gdp GameManager::reportPercentageForLevel: `a` in practice
 *  :116726-116838, `b` otherwise :116844-117027, the floors :116855-116874;
 *  GameStatsManager::checkCoinAchievement :342729-342830]
 */
export interface LevelAchievement {
  level: number;
  kind: "normal" | "practice" | "coins";
}

export function achievementLevel(id: string): LevelAchievement | null {
  let m = /^geometry\.ach\.level(\d+)([ab])$/.exec(id);
  if (m) return { level: Number(m[1]), kind: m[2] === "a" ? "practice" : "normal" };
  m = /^geometry\.ach\.tower0([1-4])(Coin)?$/.exec(id);
  if (m) return { level: 5000 + Number(m[1]), kind: m[2] ? "coins" : "normal" };
  const demon = DEMON_COINS[id];
  return demon === undefined ? null : { level: demon, kind: "coins" };
}

/** How far along one level's achievement is, 0..1. */
function levelShare(a: LevelAchievement, p: Progress): number {
  if (a.kind === "normal" && p.completed.has(a.level)) return 1;
  if (a.kind === "practice" && p.practised.has(a.level)) return 1;
  const l = p.levels.get(a.level);
  if (!l) return 0;
  if (a.kind === "coins") return l.coins.filter(Boolean).length / 3;
  return Math.min(1, (a.kind === "normal" ? l.best : l.practiceBest) / 100);
}

/**
 * Whether the player has earned achievement `id`. Null means this port cannot
 * tell — the condition is something it does not count.
 */
export function achieved(id: string, facts: AchievementFacts, p: Progress): boolean | null {
  if (id === NEAR_MISS) return p.nearMiss;
  if (menuSecret(id)) return p.earned.has(id);
  const level = achievementLevel(id);
  if (level) return levelShare(level, p) >= 1;
  if (facts.threshold === null || facts.stat === null) return null;
  switch (facts.stat) {
    case STAT.menuKills:
      return p.menuKills >= facts.threshold;
    case STAT.stars:
      return p.stars >= facts.threshold;
    case STAT.secretCoins:
      return p.secretCoins >= facts.threshold;
    case STAT.demons:
      return p.demons >= facts.threshold;
    case STAT.jumps:
      return p.jumps >= facts.threshold;
    case STAT.attempts:
      return p.attempts >= facts.threshold;
    default:
      return null;
  }
}

/** How far along an achievement is, 0..1, or null when it is not decidable here. */
export function achievementProgress(id: string, facts: AchievementFacts, p: Progress): number | null {
  if (id === NEAR_MISS) return p.nearMiss ? 1 : 0;
  if (menuSecret(id)) return p.earned.has(id) ? 1 : 0;
  const level = achievementLevel(id);
  if (level) return levelShare(level, p);
  if (facts.threshold === null || facts.threshold <= 0 || facts.stat === null) return null;
  const have =
    facts.stat === STAT.menuKills
      ? p.menuKills
      : facts.stat === STAT.stars
      ? p.stars
      : facts.stat === STAT.secretCoins
        ? p.secretCoins
        : facts.stat === STAT.demons
          ? p.demons
          : facts.stat === STAT.jumps
            ? p.jumps
            : facts.stat === STAT.attempts
              ? p.attempts
              : null;
  return have === null ? null : Math.min(1, have / facts.threshold);
}

/**
 * A sentence for an achievement, built from what is known about it. The
 * game's own titles are not in either reading of the binary.
 */
export function describeAchievement(id: string, facts: AchievementFacts, levelName: (id: number) => string): string {
  if (id === NEAR_MISS) return "Crash at 95% to 99% in normal mode";
  for (const [cube, secret] of Object.entries(MENU_CUBE_SECRETS)) {
    if (secret === id) return `Tap cube ${cube} as it runs past on the main menu`;
  }
  const level = achievementLevel(id);
  if (level) {
    const name = levelName(level.level);
    if (level.kind === "coins") return `Collect all 3 secret coins in ${name}`;
    return level.kind === "practice" ? `Complete ${name} in practice` : `Complete ${name}`;
  }
  const n = facts.threshold;
  if (n === null || facts.stat === null) return "Earned elsewhere in the game";
  const count = n.toLocaleString();
  switch (facts.stat) {
    case STAT.menuKills:
      return n === 1 ? "Tap an icon as it runs past on the main menu" : `Tap ${count} icons as they run past on the main menu`;
    case STAT.stars:
      return `Collect ${count} stars`;
    case STAT.secretCoins:
      return `Collect ${count} secret coins`;
    case STAT.demons:
      return `Beat ${count} demon${n === 1 ? "" : "s"}`;
    case STAT.jumps:
      return `Jump ${count} times`;
    case STAT.attempts:
      return `Make ${count} attempts`;
    default:
      return "Earned elsewhere in the game";
  }
}

export type Availability =
  | { state: "unlocked" }
  /** Locked behind an achievement this port can track. */
  | { state: "locked"; achievement: string }
  /** Not earnable here: the shop, a chest, a vault, or an achievement this port cannot count. */
  | { state: "elsewhere" };

/**
 * The set every player starts with. Cubes 1 to 4, the first of every other
 * kind, and the first four colours.
 * [gdp GameManager::isIconUnlocked: `a2 <= 4` for the cube and `<= 1` for
 *  the rest; isColorUnlocked: `a2 <= 3`]
 */
export function freeByDefault(kind: RewardKind, index: number): boolean {
  if (kind === "colour1" || kind === "colour2") return index >= 0 && index <= 3;
  if (kind === "cube") return index >= 1 && index <= 4;
  if (kind === "death" || kind === "special") return index <= 1;
  return index === 1;
}

/**
 * Whether one icon or colour can be worn, and if not, why.
 *
 * `achievements` is the whole table; the first one whose reward is this item
 * and that the player has earned wins, and failing that the first one this
 * port can at least count is named as the way to get it.
 */
export function availability(
  kind: RewardKind,
  index: number,
  achievements: ReadonlyArray<{ id: string } & AchievementFacts>,
  p: Progress,
): Availability {
  if (freeByDefault(kind, index)) return { state: "unlocked" };
  let countable: string | null = null;
  for (const a of achievements) {
    const reward = parseReward(a.reward);
    if (!reward || reward.kind !== kind || reward.index !== index) continue;
    const done = achieved(a.id, a, p);
    if (done === true) return { state: "unlocked" };
    if (done === false && countable === null) countable = a.id;
  }
  return countable === null ? { state: "elsewhere" } : { state: "locked", achievement: countable };
}
