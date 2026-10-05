// The game's own text and per-level facts, as the build's `strings` step read
// them out of the binary. Loaded once and handed round; nothing here derives
// anything the game did not say.

import { fetchAsset } from "./paths";
import type { AchievementFacts, LevelFacts, SongInfo, StringsFile } from "./stringTypes";

/**
 * Who made each official track, by song index. The binary keeps this in a
 * table the decompile does not include, so it is the soundtrack's published
 * credits instead.
 */
const SONG_ARTISTS: Record<number, string> = {
  0: "ForeverBound", 1: "DJVI", 2: "Step", 3: "DJVI", 4: "DJVI", 5: "DJVI",
  6: "Waterflame", 7: "Waterflame", 8: "DJVI", 9: "DJVI", 10: "Waterflame",
  11: "DJ-Nate", 12: "Waterflame", 13: "DJ-Nate", 14: "DJ-Nate", 15: "Waterflame",
  16: "Waterflame", 17: "DJ-Nate", 18: "Waterflame", 19: "F-777", 20: "MDK", 21: "MDK",
  22: "Hinkik", 23: "F-777", 24: "F-777", 25: "F-777", 26: "RobTop",
  27: "Dex Arson", 28: "Dex Arson", 29: "Dex Arson", 30: "Dex Arson", 31: "Dex Arson",
  32: "Waterflame", 33: "Waterflame", 34: "Dex Arson", 35: "Dex Arson", 36: "F-777",
  37: "MDK", 38: "Bossfight", 39: "Boom Kitty",
};

export class Strings {
  private constructor(private readonly file: StringsFile) {}

  static async load(): Promise<Strings> {
    return new Strings(await fetchAsset<StringsFile>("strings.json"));
  }

  /**
   * A loading tip, drawn the way the game draws one: a roll of 0–99 against a
   * table that does not fill every slot, with the unfilled ones falling through
   * to "Loading resources". Takes the roll so a caller can use the level's own
   * RNG and stay deterministic.
   */
  loadingTip(roll: number): string {
    return this.file.loadingTips[Math.abs(Math.trunc(roll)) % 100] ?? "Loading resources";
  }

  /** One of the game's player colours, or white for an index it does not have. */
  playerColour(index: number): { r: number; g: number; b: number } {
    const c = this.file.playerColours[index];
    return c ? { r: c[0], g: c[1], b: c[2] } : { r: 255, g: 255, b: 255 };
  }

  get playerColourCount(): number {
    return this.file.playerColours.length;
  }

  achievement(id: string): AchievementFacts | undefined {
    return this.file.achievements[id];
  }

  /** Every achievement the binary gave up, with its id. */
  achievements(): Array<{ id: string } & AchievementFacts> {
    return Object.entries(this.file.achievements).map(([id, facts]) => ({ id, ...facts }));
  }

  facts(levelId: number): (LevelFacts & { name: string }) | undefined {
    return this.file.levels[levelId];
  }

  song(index: number): SongInfo | undefined {
    const song = this.file.songs[index];
    if (!song || song.artist) return song;
    const artist = SONG_ARTISTS[index];
    return artist ? { ...song, artist } : song;
  }

  /**
   * The official track a level plays, for its credit. A tower floor plays a
   * music-library song whose title is not in the binary, so it has none.
   */
  songForLevel(levelId: number): SongInfo | undefined {
    const facts = this.facts(levelId);
    if (!facts || (facts.songId ?? 0) > 0) return undefined;
    return this.song(facts.song);
  }

  /** What a level's music is: an official track's file and index, or a custom song id. */
  levelTrack(levelId: number): { file: string; index: number } | { songId: number } | undefined {
    const facts = this.facts(levelId);
    if (!facts) return undefined;
    if ((facts.songId ?? 0) > 0) return { songId: facts.songId };
    const song = this.song(facts.song);
    return song ? { file: song.file, index: facts.song } : undefined;
  }

  /** The beat script a song pulses to, as alternating times and strengths, if it has one. */
  songPulse(index: number): readonly number[] | undefined {
    return this.file.songPulses?.[index];
  }

  artist(index: number): string | undefined {
    return this.file.artists[index]?.name;
  }

  /** What the extraction could not recover, so a caller can say so rather than show a blank. */
  get gaps(): readonly string[] {
    return this.file.gaps;
  }
}
