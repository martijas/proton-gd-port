// The build's `strings` step reads tables out of the decompile by regex, which
// is exactly the kind of extraction that fails quietly: a table shape changes,
// a window slips into the next branch, and the result is plausible and wrong.
//
// So these check the output against facts that do not come from the extractor:
// the star counts the game awards, which three levels are demons, the mp3 files
// actually present in the install, and the level names the port already keeps
// in its own table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OFFICIAL_LEVELS } from "../src/assets/levels";
import { difficultyFrame, type StringsFile } from "../src/assets/stringTypes";
import { achievementThresholds, functionBody, levelReports, namedLevelFacts } from "../tools/assets/strings";
import { projectPath, outPath } from "./helpers";

const ASSETS = outPath("assets");
const PATH = join(ASSETS, "strings.json");
const SKIP = existsSync(PATH) ? false : "run `npm run assets` first";

function load(): StringsFile {
  return JSON.parse(readFileSync(PATH, "utf8")) as StringsFile;
}

/**
 * Stars for the main twenty-two, as the game awards them, written out by hand.
 * This is the independent check: it is a fact about the game rather than an
 * echo of the extractor, and it pins every branch of `getLevel` to a level.
 *
 * Difficulty deliberately is *not* listed here. I got several wrong from memory
 * on the first attempt (Cycles is Harder, not Insane), so a hand table of it
 * would be a second guess dressed up as a check. What is asserted below instead
 * is the part that is genuinely knowable without the binary: which three levels
 * are demons, and that the demon flag and the difficulty number agree.
 */
const STARS: Record<number, number> = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11,
  12: 12, 13: 10, 14: 14, 15: 12, 16: 12, 17: 10, 18: 14, 19: 10, 20: 15,
  21: 12, 22: 12,
};

/** The only three official levels that carry a demon face. */
const DEMONS = new Set([14, 18, 20]);

test("every official level awards the stars the game awards", { skip: SKIP }, () => {
  const s = load();
  for (const [id, stars] of Object.entries(STARS)) {
    const got = s.levels[Number(id)];
    assert.ok(got, `level ${id} is missing from strings.json`);
    assert.equal(got.stars, stars, `level ${id} stars`);
  }
});

test("the three demons are the three demons, and nothing else is", { skip: SKIP }, () => {
  const s = load();
  for (const [id, level] of Object.entries(s.levels)) {
    const n = Number(id);
    if (n > 22) continue;
    assert.equal(level.demon, DEMONS.has(n), `level ${id} demon flag`);
    // The game writes 6 into the difficulty field for exactly the demons.
    assert.equal(level.difficulty === 6, level.demon, `level ${id}: difficulty 6 and the demon flag should agree`);
  }
});

test("difficulty is one of the faces the game draws", { skip: SKIP }, () => {
  const s = load();
  for (const [id, level] of Object.entries(s.levels)) {
    // Every official level has a getLevel branch, so every one is rated.
    assert.ok(level.difficulty >= 1 && level.difficulty <= 6, `level ${id} difficulty ${level.difficulty}`);
    assert.ok(level.stars >= 1 && level.stars <= 15, `level ${id} stars ${level.stars}`);
  }
});

/**
 * The five branches getLevel opens with the level's name: the track, the
 * song id the exe writes for each floor, the difficulty and the stars.
 * [gdp LevelTools::getLevel, gd-ida-decomp.cpp:120993-121063; the song ids
 *  from GeometryDash.exe 0x1403276ba, 0x140327533, 0x1403273ab, 0x140327216]
 */
const NAMED: Record<number, { song: number; songId: number; difficulty: number; stars: number; name: string }> = {
  3001: { song: 26, songId: 0, difficulty: 3, stars: 3, name: "The Challenge" },
  5001: { song: 0, songId: 10003039, difficulty: 2, stars: 5, name: "The Tower" },
  5002: { song: 0, songId: 10003129, difficulty: 3, stars: 6, name: "The Sewers" },
  5003: { song: 0, songId: 10002875, difficulty: 4, stars: 7, name: "The Cellar" },
  5004: { song: 0, songId: 10006086, difficulty: 4, stars: 7, name: "The Secret Hollow" },
};

test("the named getLevel branches are read for The Challenge and the four floors", () => {
  const src = readFileSync(projectPath("data/ref/gd-ida-decomp.cpp"), "utf8");
  const named = namedLevelFacts(functionBody(src, "GJGameLevel *__fastcall LevelTools::getLevel("));
  assert.deepEqual([...named.keys()].sort((a, b) => a - b), [3001, 5001, 5002, 5003, 5004]);
  for (const [id, want] of Object.entries(NAMED)) {
    const got = named.get(Number(id));
    assert.ok(got, `level ${id}`);
    assert.deepEqual(
      { song: got.song, songId: got.songId, difficulty: got.difficulty, stars: got.stars, name: got.name, demon: got.demon },
      { ...want, demon: false },
      `level ${id}`,
    );
  }
  assert.equal(named.get(3001)?.extra, "73_237_29_40_29_29_237_98_29_29_237_237_132_29_29_29");
});

test("The Challenge and the four floors come from their own getLevel branches", { skip: SKIP }, () => {
  const s = load();
  for (const [id, want] of Object.entries(NAMED)) {
    const got = s.levels[Number(id)];
    assert.ok(got, `level ${id} is missing from strings.json`);
    assert.deepEqual(
      { song: got.song, songId: got.songId, difficulty: got.difficulty, stars: got.stars, name: got.name, demon: got.demon },
      { ...want, demon: false },
      `level ${id}`,
    );
  }
  assert.equal(s.levels[3001].extra, "73_237_29_40_29_29_237_98_29_29_237_237_132_29_29_29");
  assert.equal([5001, 5002, 5003, 5004].reduce((sum, id) => sum + s.levels[id].stars, 0), 25);
  // Track 26, "Secret", is The Challenge's. [LevelTools::getAudioFileName]
  assert.equal(s.songs[26].file, "DJRubRub.mp3");
  assert.ok(Object.keys(s.songs).every((k) => Number(k) < 1000), "every song is one of the game's own");
  assert.ok(!s.gaps.some((g) => g.includes("has no branch")), "no level is missing a branch");
});

test("the level names agree with the port's own table", { skip: SKIP }, () => {
  const s = load();
  for (const level of OFFICIAL_LEVELS) {
    const got = s.levels[level.id];
    assert.ok(got, `level ${level.id} is missing from strings.json`);
    // The game spells a couple without their apostrophe ("Cant Let Go").
    const norm = (v: string): string => v.replace(/['']/g, "").toLowerCase();
    assert.equal(norm(got.name), norm(level.name), `level ${level.id}`);
  }
});

test("every song an official level plays is in the build", { skip: SKIP }, () => {
  const s = load();
  if (!existsSync(join(ASSETS, "audio", "music"))) return; // built with --no-audio
  for (const level of Object.values(s.levels)) {
    // A floor plays a music-library song instead of its track.
    if (level.songId > 0) {
      assert.ok(existsSync(join(ASSETS, "audio", "songs", `${level.songId}.ogg`)), `${level.name}'s song ${level.songId} is not in the build`);
      continue;
    }
    const song = s.songs[level.song];
    assert.ok(song, `song ${level.song} has no entry`);
    assert.ok(
      existsSync(join(ASSETS, "audio", "music", song.file)),
      `${song.title} (${song.file}) is not in the build`,
    );
  }
});

test("the songs the install does not carry are the downloadable ones", { skip: SKIP }, () => {
  const s = load();
  if (!existsSync(join(ASSETS, "audio", "music"))) return;
  const played = new Set(Object.values(s.levels).map((l) => l.song));
  for (const [index, song] of Object.entries(s.songs)) {
    if (existsSync(join(ASSETS, "audio", "music", song.file))) continue;
    // The map packs and gauntlets name tracks the game fetches rather than
    // ships. No official level may depend on one.
    assert.ok(!played.has(Number(index)), `${song.title} is played by a level but is not in the install`);
  }
});

test("the loading tips are the game's, keyed by its own roll", { skip: SKIP }, () => {
  const s = load();
  const rolls = Object.keys(s.loadingTips).map(Number);
  assert.ok(rolls.length > 90, `only ${rolls.length} tips`);
  assert.ok(Math.min(...rolls) >= 0 && Math.max(...rolls) < 100, "rolls are a rand() % 100");
  assert.equal(s.loadingTips[1], "Listen to the music to help time your jumps");
  for (const tip of Object.values(s.loadingTips)) assert.ok(tip.length > 0, "no empty tips");
});

test("what could not be extracted is recorded rather than guessed", { skip: SKIP }, () => {
  const s = load();
  // The song-to-artist link lives in a byte array the pseudo-C leaves out, so
  // every song's artist is null and that has to be stated, not silently empty.
  assert.ok(
    s.gaps.some((g) => g.includes("artistForAudio")),
    "the missing song-to-artist link should be listed in gaps",
  );
  for (const [index, song] of Object.entries(s.songs)) assert.equal(song.artist, null, `song ${index}`);
  assert.ok(Object.keys(s.artists).length >= 12, "the artist names themselves are readable");
});

test("the difficulty face frame follows the demon flag, not just the number", () => {
  assert.equal(difficultyFrame({ difficulty: 5, demon: false }), "difficulty_05_btn_001.png");
  assert.equal(difficultyFrame({ difficulty: 6, demon: true }), "difficulty_06_btn_001.png");
  assert.equal(difficultyFrame({ difficulty: 1, demon: true }), "difficulty_06_btn_001.png");
});

// --- the player colours and the achievements ---------------------------------

test("the player colour table is the game's, in its own order", { skip: SKIP }, () => {
  const file = load();
  // 107 swatches, 0 to 106; the first four are the ones every player starts with.
  assert.equal(file.playerColours.length, 107);
  assert.deepEqual(file.playerColours[0], [125, 255, 0]);
  assert.deepEqual(file.playerColours[1], [0, 255, 0]);
  assert.deepEqual(file.playerColours[3], [0, 255, 255]);
  assert.deepEqual(file.playerColours[5], [0, 0, 255]);
  // A signed byte read as one: -1 is 255, not 255 less something.
  for (const [r, g, b] of file.playerColours) {
    for (const v of [r, g, b]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${r},${g},${b}`);
  }
});

test("achievements carry what earns them and what they unlock", { skip: SKIP }, () => {
  const file = load();
  const stars5 = file.achievements["geometry.ach.stars05"];
  assert.ok(stars5, "the fifth stars achievement should be there");
  assert.equal(stars5.stat, 6, "stars are stat 6");
  assert.equal(stars5.threshold, 500);
  assert.equal(stars5.reward, "ship_04");
  const coins19 = file.achievements["geometry.ach.coins19"];
  assert.equal(coins19?.stat, 8, "secret coins are stat 8");
  assert.equal(coins19?.reward, "icon_43");
  const jump1 = file.achievements["geometry.ach.jump01"];
  assert.equal(jump1?.threshold, 1000, "the first jump achievement is a thousand jumps");
  // A per-level achievement has a reward but no stat check; that is the binary, not a gap.
  assert.equal(file.achievements["geometry.ach.level01a"]?.stat, null);
  // The rewards, the check routine's reports and the per-level reports.
  assert.equal(Object.keys(file.achievements).length, 431);
  const a = (id: string) => file.achievements[`geometry.ach.${id}`];
  assert.deepEqual(a("demon01"), { stat: 5, threshold: 1, reward: "icon_19" });
  assert.deepEqual(a("demon02"), { stat: 5, threshold: 2, reward: "icon_20" });
  assert.deepEqual(a("demon04"), { stat: 5, threshold: 4, reward: "icon_22" });
  assert.deepEqual(a("usercoins01"), { stat: 12, threshold: 1, reward: "dart_02" });
  assert.deepEqual(a("shardBonus01"), { stat: null, threshold: 5, reward: "icon_98" });
  for (const id of ["tower01", "tower01Coin", "level22b"]) assert.deepEqual(a(id), { stat: null, threshold: null, reward: null }, id);
  assert.deepEqual(a("jump11"), { stat: 1, threshold: 1000000, reward: null });
});

// The extractor itself, read against the decompile rather than the build.
// [gdp GameStatsManager::checkAchievement :350163-352632;
//  GameManager::reportPercentageForLevel :116718-117030;
//  GameStatsManager::checkCoinAchievement :342692-342833]

test("every achievement the check routine reports is read, with its stat and count", () => {
  const src = readFileSync(projectPath("data/ref/gd-ida-decomp.cpp"), "utf8");
  const body = functionBody(src, "int *__fastcall GameStatsManager::checkAchievement(");
  const t = achievementThresholds(body);
  const got = (id: string) => t.get(`geometry.ach.${id}`);
  assert.equal(t.size, 315);
  for (const m of body.matchAll(/"(geometry.ach.[^"%]+)"/g)) assert.ok(t.has(m[1]), m[1]);
  // The hex cases, and the ones reported whole once the stat is above 0.
  assert.deepEqual(got("like02"), { stat: 10, threshold: 100 });
  assert.deepEqual(got("usercoins01"), { stat: 12, threshold: 1 });
  assert.deepEqual(got("usercoins40"), { stat: 12, threshold: 3000 });
  assert.deepEqual(got("daily01"), { stat: 15, threshold: 1 });
  assert.deepEqual(got("gauntlets01"), { stat: 40, threshold: 1 });
  assert.deepEqual(got("lists07"), { stat: 41, threshold: 200 });
  assert.deepEqual(got("custom01"), { stat: 4, threshold: 1 });
  assert.deepEqual(got("mappacks01"), { stat: 7, threshold: 1 });
  assert.deepEqual(got("mappacks10"), { stat: 7, threshold: 45 });
  // v * 0.5 and v * 0.25 are divisors of 2 and 4.
  assert.deepEqual(got("demon01"), { stat: 5, threshold: 1 });
  assert.deepEqual(got("demon02"), { stat: 5, threshold: 2 });
  assert.deepEqual(got("demon03"), { stat: 5, threshold: 3 });
  assert.deepEqual(got("demon04"), { stat: 5, threshold: 4 });
  assert.deepEqual(got("demon27"), { stat: 5, threshold: 500 });
  // Each case's last, reported through a shared tail.
  assert.deepEqual(got("jump11"), { stat: 1, threshold: 1000000 });
  assert.deepEqual(got("attempt14"), { stat: 2, threshold: 300000 });
  assert.deepEqual(got("stars33"), { stat: 6, threshold: 25000 });
  assert.deepEqual(got("coins28"), { stat: 8, threshold: 160 });
  assert.deepEqual(got("moons26"), { stat: 28, threshold: 10000 });
  assert.deepEqual(got("secret18"), { stat: 9, threshold: 750 });
  assert.deepEqual(got("shardShadow05"), { stat: 16, threshold: 100 });
  assert.deepEqual(got("shardSoul05"), { stat: 27, threshold: 100 });
  // The bonuses count the least of five shard stats.
  assert.deepEqual(got("shardBonus01"), { stat: null, threshold: 5 });
  assert.deepEqual(got("shardBonus05"), { stat: null, threshold: 100 });
  assert.deepEqual(got("shardBonusB01"), { stat: null, threshold: 5 });
  assert.deepEqual(got("shardBonusB04"), { stat: null, threshold: 65 });
  // Stat 9 is the menu icons destroyed, and only these six count it.
  const nine = [...t].filter(([, v]) => v.stat === 9).map(([id]) => id.replace("geometry.ach.", "")).sort();
  assert.deepEqual(nine, ["secret01", "secret02", "secret02b", "secret03", "secret03b", "secret18"]);
  assert.ok(![...t.keys()].some((id) => id.includes("path")), "the paths' ids are built from a format");
});

test("the per-level achievements are read from the two routines that report them", () => {
  const src = readFileSync(projectPath("data/ref/gd-ida-decomp.cpp"), "utf8");
  const ids = levelReports(
    functionBody(src, "int *__fastcall GameManager::reportPercentageForLevel("),
    functionBody(src, "int *__fastcall GameStatsManager::checkCoinAchievement("),
  );
  assert.equal(ids.size, 62);
  for (const id of ["level22a", "level22b", "tower04", "tower04Coin", "demoncoin02", "special01", "subzero.level003"]) {
    assert.ok(ids.has(`geometry.ach.${id}`), id);
  }
  assert.ok(![...ids].some((id) => id.startsWith("geometry.ach.world.")), "the world levels' ids are a format");
});
