// The shape of assets/strings.json: the text and per-level facts that the game
// compiles in rather than shipping as data, pulled out by the build's `strings`
// step. Kept here rather than in tools/ so the runtime and the generator cannot
// drift, the same way the atlas and font shapes are.

/** What `LevelTools::getLevel` records about one official level. */
export interface LevelFacts {
  /** Index into `songs`, not a level id. */
  song: number;
  /**
   * A custom song the level plays instead of its track, 0 for none: the tower
   * floors' music-library songs. [gdp GJGameLevel::getAudioFileName
   *  :270024-270041; LevelTools::getLevel :120993-121049]
   */
  songId: number;
  /**
   * 1 easy, 2 normal, 3 hard, 4 harder, 5 insane; 6 means the demon faces.
   * 0 is the game's own "not rated" face.
   */
  difficulty: number;
  stars: number;
  demon: boolean;
  /** An underscore-separated list the game stores alongside; kept verbatim, unread. */
  extra: string | null;
}

export interface SongInfo {
  title: string;
  /** File name inside audio/music/. */
  file: string;
  artist: string | null;
  url: string | null;
}

/**
 * One achievement as far as the binary gives it up. The definitions with the
 * titles and descriptions did not decompile and the strings are not in the
 * exe either, so what is here is the shape of the condition and the reward,
 * both of which are.
 */
export interface AchievementFacts {
  /**
   * Which stat the game checks it against, by its own stat number: 1 jumps,
   * 2 attempts, 4 online levels, 5 demons, 6 stars, 7 map packs, 8 secret
   * coins, 9 menu icons destroyed, 10 likes, 11 ratings, 12 user coins, 13
   * diamonds, 15 daily levels, 16-20 and 23-27 shards, 28 moons, 40
   * gauntlets, 41 lists. Null for the ones the check routine does not report
   * — the per-level and social ones — and for the shard bonuses, which count
   * the least of five shard stats.
   */
  stat: number | null;
  /**
   * The count that earns it: the divisor the check reports against, or 1 for
   * one reported once the stat is above 0.
   */
  threshold: number | null;
  /** What earning it unlocks, in the game's own spelling: `icon_43`, `color2_25`, `bird_09`. */
  reward: string | null;
}

export interface StringsFile {
  version: 1;
  /**
   * The player colour table, `GameManager::colorForIdx`, in its own order:
   * the index the save stores is the index here.
   */
  playerColours: Array<[number, number, number]>;
  /** Keyed by the game's own ids, `geometry.ach.stars05`. */
  achievements: Record<string, AchievementFacts>;
  /**
   * The loading screen's tips, keyed by the `rand() % 100` roll that picks
   * them. Rolls the game's switch does not name fall through to its default, so
   * a missing key is the game's behaviour rather than a gap in the extraction.
   */
  loadingTips: Record<number, string>;
  songs: Record<number, SongInfo>;
  /**
   * The beat script each older song pulses to, by song index: times in
   * seconds and strengths, alternating.
   * [gdp LevelTools::getAudioString :121729-122057]
   */
  songPulses: Record<number, number[]>;
  artists: Record<number, { name: string; url: string | null }>;
  levels: Record<number, LevelFacts & { name: string }>;
  /** What the decompile could not give up, counted rather than invented. */
  gaps: string[];
}

/** The five difficulty faces, by the number `getLevel` writes. */
export const DIFFICULTY_NAMES: Record<number, string> = {
  0: "N/A",
  1: "Easy",
  2: "Normal",
  3: "Hard",
  4: "Harder",
  5: "Insane",
  6: "Demon",
};

/** The frame the difficulty face draws with, e.g. `difficulty_03_btn_001.png`. */
export function difficultyFrame(facts: Pick<LevelFacts, "difficulty" | "demon">): string {
  const n = facts.demon ? 6 : Math.max(0, Math.min(5, facts.difficulty));
  return `difficulty_${String(n).padStart(2, "0")}_btn_001.png`;
}
