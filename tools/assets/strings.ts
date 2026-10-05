// The text and the per-level facts that are compiled into the game rather than
// shipped as data: loading tips, song titles and credits, and each official
// level's song, difficulty and star count.
//
// None of it exists as a file in the install, so the source here is the 2.206
// decompile in data/ref/, which is a reading of the very exe the rest of the
// build copies from. Everything below comes out of a plain
// `switch (n) { case N: s = "..."; }` table, which is what makes reading it
// mechanical rather than a guess — each table is located by its function
// signature and parsed in place, and the step fails loudly if one comes back
// the wrong size rather than shipping a short table quietly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileSize, writeJson } from "./fsx";
import type { AchievementFacts, LevelFacts, SongInfo, StringsFile } from "../../src/assets/stringTypes";
import { LEVEL_IDS } from "./levels";
import type { StepContext, StepModule, StepResult } from "./step";

const DECOMP = "ref/gd-ida-decomp.cpp";

/** The slice of the file holding one function, found by its signature line. */
export function functionBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`${signature} is not in the decompile`);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? at + 200_000 : end);
}

/**
 * `case N: <var> = "text"; break;` pairs, in order. IDA renders every one of
 * these tables the same way, so one reader serves all of them.
 */
function switchStrings(body: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /case (-?\d+):\s*\n\s*\w+ = "((?:[^"\\]|\\.)*)";/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.set(Number(m[1]), unescapeC(m[2]));
  return out;
}

function unescapeC(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * What `LevelTools::getLevel` sets for one official level.
 *
 * The function is a binary search whose level ids IDA renders as addresses
 * (`&byte_7`, `&dword_0 + 3`), which are not worth decoding. The song index is,
 * though: every branch opens with `getAudioTitle(&v18, <song>, v6)` and then
 * writes that same number to `+88`, so the blocks are keyed by song and matched
 * to level ids afterwards.
 */
function levelFacts(body: string): Map<number, LevelFacts> {
  const out = new Map<number, LevelFacts>();
  const re = /getAudioTitle\(\(LevelTools \*\)&v18, (\d+), v6\);/g;
  const starts: number[] = [];
  let scan: RegExpExecArray | null;
  const scanner = new RegExp(re.source, "g");
  while ((scan = scanner.exec(body)) !== null) starts.push(scan.index);
  let m: RegExpExecArray | null;
  let nth = 0;
  while ((m = re.exec(body)) !== null) {
    const song = Number(m[1]);
    // The branch ends where the next one starts. A fixed window instead reads
    // the *following* level's fields — which is how level 19 came out a demon
    // on the first attempt, having borrowed Deadlocked's setDemon call.
    const block = body.slice(m.index, starts[++nth] ?? body.length);
    const echoed = /\+ 88\) = (\d+);/.exec(block);
    // A branch is only a level definition when it writes the song back to +88.
    if (!echoed || Number(echoed[1]) !== song) continue;
    const difficulty = /\+ 87\) = (\d+);/.exec(block);
    const stars = /setStars\(v7, (\d+)\)/.exec(block);
    if (!difficulty || !stars) continue;
    out.set(song, {
      song,
      songId: 0,
      difficulty: Number(difficulty[1]),
      stars: Number(stars[1]),
      demon: /setDemon\(v7, 1\)/.test(block),
      extra: /"((?:\d+_)+\d+)"/.exec(block)?.[1] ?? null,
    });
  }
  return out;
}

/** Level ids of the getLevel branches that open with the level's name. */
const NAMED_LEVELS: Record<string, number> = {
  "The Challenge": 3001,
  "The Tower": 5001,
  "The Sewers": 5002,
  "The Cellar": 5003,
  "The Secret Hollow": 5004,
};

/**
 * The floors' song ids. IDA prints the +89 store as a string pointer, so the
 * values come from the PC exe, where each is `mov dword [rbx+0x2a0], imm32`.
 * [gdp LevelTools::getLevel :120995-121049; GeometryDash.exe 0x1403276ba,
 *  0x140327533, 0x1403273ab, 0x140327216]
 */
const FLOOR_SONG_IDS: Record<number, number> = { 5001: 10003039, 5002: 10003129, 5003: 10002875, 5004: 10006086 };

/**
 * The five `getLevel` branches that open with the level's name rather than
 * getAudioTitle: The Challenge and the four tower floors. Each runs to the
 * next one or to its goto.
 * [gdp LevelTools::getLevel :120993-121063]
 */
export function namedLevelFacts(body: string): Map<number, LevelFacts & { name: string }> {
  const out = new Map<number, LevelFacts & { name: string }>();
  const hits = [...body.matchAll(/sub_75309C\(&v18, "([^"]+)", \(int\)v17\);/g)].filter((m) => NAMED_LEVELS[m[1]] !== undefined);
  hits.forEach((m, i) => {
    const id = NAMED_LEVELS[m[1]];
    const from = m.index ?? 0;
    const next = hits[i + 1]?.index ?? body.length;
    const jump = body.indexOf("goto LABEL_", from);
    const block = body.slice(from, jump >= 0 ? Math.min(jump, next) : next);
    const track = /\+ 88\) = (\d+);/.exec(block);
    const difficulty = /\+ 87\) = (\d+);/.exec(block);
    const stars = /setStars\(v7, (\d+)\)/.exec(block);
    if (!track || !difficulty || !stars) throw new Error(`getLevel's "${m[1]}" branch has changed shape`);
    const writesSong = /\+ 89\) = "/.test(block);
    if (writesSong !== (FLOOR_SONG_IDS[id] !== undefined)) throw new Error(`getLevel's "${m[1]}" song id does not match the table`);
    out.set(id, {
      song: Number(track[1]),
      songId: FLOOR_SONG_IDS[id] ?? 0,
      difficulty: Number(difficulty[1]),
      stars: Number(stars[1]),
      demon: false,
      extra: /"((?:\d+_)+\d+)"/.exec(block)?.[1] ?? null,
      name: m[1],
    });
  });
  if (out.size !== 5) throw new Error(`only ${out.size} of getLevel's five named branches were read`);
  return out;
}

/**
 * `GameManager::colorForIdx`: `case N: v3 = r; v4 = g; v5 = b;` with the three
 * in whatever order IDA felt like and the bytes signed, so -1 is 255 and -106
 * is 150. The default branch is white and is not a colour.
 */
function playerColours(body: string): Array<[number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  const re = /case (\d+):\s*\n((?:\s*v[345] = [^;]+;\s*\n){3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const vals: Record<string, number> = {};
    for (const part of m[2].matchAll(/(v[345]) = ([^;]+);/g)) vals[part[1]] = signedByte(part[2].trim());
    out.set(Number(m[1]), [vals.v3 ?? 255, vals.v4 ?? 255, vals.v5 ?? 255]);
  }
  const count = out.size === 0 ? 0 : Math.max(...out.keys()) + 1;
  const list: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) list.push(out.get(i) ?? [255, 255, 255]);
  return list;
}

function signedByte(token: string): number {
  const value = token.startsWith("0x") ? parseInt(token, 16) : Number(token);
  return ((value % 256) + 256) % 256;
}

/**
 * `AchievementManager::getAchievementRewardDict` builds one dictionary of reward -> achievement,
 * `"icon_43"` -> `"geometry.ach.coins19"`, as pairs of string temporaries.
 * The definitions themselves, with the titles, are in
 * `addManualAchievements`, which did not decompile.
 */
function achievementRewards(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /sub_75309C\(&v\d+, "([A-Za-z0-9_ ]+)", \(int\)v\d+\);\s*\n\s*v\d+ = \(cocos2d::CCObject \*\)cocos2d::CCString::create\(&v\d+\);\s*\n\s*sub_75309C\(&v\d+, "(geometry\.ach\.[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.set(m[2], m[1].trim());
  return out;
}

/**
 * `GameStatsManager::checkAchievement` reports each achievement as a
 * percentage of a stat over a divisor — `floorf(stat / 100.0 * 100)` for the
 * first stars achievement — inside a `case N:` per stat, hex from 10 on. The
 * divisor is the count that earns it and the case is which stat. Four shapes
 * carry it: `v / N`, `v / N.0`, `(float)v / N.0`, and `v * 0.5` or `v * 0.25`,
 * which are divisors of 2 and 4. The first of some cases is reported whole
 * once the stat is above 0, so its count is 1; each case's last goes to a
 * shared tail through a variable, with the last divisor. The shard bonuses
 * count the least of five shard stats, so they carry no stat of their own.
 * The paths (cases 0x1E-0x27) build their ids from a format and are not read.
 * [gdp GameStatsManager::checkAchievement, gd-ida-decomp.cpp:350163-352632:
 *  the first hex case :351850; demon02 and demon04 :351419, :351427; the
 *  whole reports, e.g. :351354-351357, :351900-351903; the tails, e.g.
 *  :351258-351262, :352272-352274; the bonuses :352274-352306,
 *  :352421-352454]
 */
export function achievementThresholds(body: string): Map<string, { stat: number | null; threshold: number }> {
  const out = new Map<string, { stat: number | null; threshold: number }>();
  let stat: number | null = 0;
  let divisor: number | null = null;
  const note = (id: string, threshold: number): void => {
    if (!out.has(id)) out.set(id, { stat, threshold });
  };
  for (const line of body.split("\n")) {
    const c = /^\s*case (0x[0-9A-Fa-f]+|\d+)u?:/.exec(line);
    if (c) {
      stat = Number(c[1]);
      divisor = null;
      continue;
    }
    // The bonus tails read five stats by name and take the least.
    if (/getStat\(this, "\d+"\)/.test(line)) stat = null;
    const f = /floorf\(\(float\)\((?:\(float\))?\w+ ([/*]) ([\d.]+)\)/.exec(line);
    if (f) {
      divisor = f[1] === "/" ? Number(f[2]) : 1 / Number(f[2]);
      continue;
    }
    const whole = /reportAchievementWithID\([^,]+, "(geometry\.ach\.[^"]+)", \(const char \*\)&dword_64,/.exec(line);
    if (whole) {
      note(whole[1], 1);
      continue;
    }
    const r = /reportAchievementWithID\([^,]+, "(geometry\.ach\.[^"]+)"/.exec(line);
    if (r && divisor !== null) {
      note(r[1], divisor);
      continue;
    }
    const tail = /^\s*v\d+ = "(geometry\.ach\.[^"]+)";/.exec(line);
    if (tail && divisor !== null) note(tail[1], divisor);
  }
  return out;
}

/**
 * The achievements reported about one level rather than from a stat — the
 * per-level pairs, special01, the floors and the coin sets — which the reward
 * table only partly lists. They carry no stat and no count. The world
 * levels' ids are built from a format and are not read.
 * [gdp GameManager::reportPercentageForLevel :116718-117030;
 *  GameStatsManager::checkCoinAchievement :342692-342833]
 */
export function levelReports(...bodies: string[]): Set<string> {
  const out = new Set<string>();
  for (const body of bodies) for (const m of body.matchAll(/"(geometry\.ach\.[A-Za-z0-9.]+)"/g)) out.add(m[1]);
  return out;
}

/** The install's executable, beside its Resources folder. */
function exePath(ctx: StepContext): string {
  return join(ctx.src, "..", "GeometryDash.exe");
}

/**
 * The beat scripts the older official songs pulse to: `time~strength~...`,
 * one per song index. `LevelTools::getAudioString` is a switch whose cases
 * either carry the text inline, split across several literals, or name a
 * string constant (`a03208005308008`) the decompile leaves out. IDA names a
 * constant for the digits it opens with, so each is found again among the
 * exe's own strings; the inline ones are looked up there too, as a check that
 * the two agree. A case that loads the empty string has no script.
 * [gdp LevelTools::getAudioString :121729-122057; AudioEffectsLayer::init
 *  :329565-329628 (split on "~")]
 */
export function songPulses(body: string, exe: Buffer): Record<number, number[]> {
  const pool: string[] = [];
  let start = -1;
  for (let i = 0; i <= exe.length; i++) {
    const c = exe[i];
    if (i < exe.length && ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x7e)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start > 100 && exe[i] === 0) pool.push(exe.toString("latin1", start, i));
    start = -1;
  }
  const digits = (s: string): string => s.replace(/[^0-9]/g, "");
  const out: Record<number, number[]> = {};
  const cases = [...body.matchAll(/case (\d+):\s*\n\s*v\d+ = ([^;]+);/g)];
  for (const m of cases) {
    const index = Number(m[1]);
    const value = m[2].trim();
    let text: string;
    if (value.startsWith('"')) {
      text = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((p) => p[1]).join("");
      if (!pool.includes(text)) throw new Error(`song ${index}'s beat script is not in the exe as the decompile has it`);
    } else if (/^a\d+$/.test(value)) {
      const want = value.slice(1);
      const hits = pool.filter((s) => digits(s.slice(0, 48)).startsWith(want));
      if (hits.length !== 1) throw new Error(`song ${index}'s beat script (${value}) matched ${hits.length} strings in the exe`);
      text = hits[0];
    } else {
      continue;
    }
    const nums = text.split("~").filter((s) => s !== "").map(Number);
    if (nums.length % 2 !== 0 || nums.some((n) => !Number.isFinite(n))) throw new Error(`song ${index}'s beat script does not parse`);
    out[index] = nums;
  }
  return out;
}

export const stringsStep: StepModule = {
  name: "strings",

  inputs(ctx: StepContext): string[] {
    return [join(ctx.data, DECOMP), exePath(ctx)];
  },

  run(ctx: StepContext): StepResult {
    const rel = "strings.json";
    const dest = join(ctx.out, rel);
    if (ctx.opts.verify) {
      return { files: 0, bytes: fileSize(dest), skipped: 1, summary: "not rebuilt", outputs: [rel] };
    }

    const src = readFileSync(join(ctx.data, DECOMP), "utf8");
    const gaps: string[] = [];

    const tips = switchStrings(functionBody(src, "const char *__fastcall LoadingLayer::getLoadingString("));
    const titles = switchStrings(functionBody(src, "LevelTools *__fastcall LevelTools::getAudioTitle("));
    const files = switchStrings(functionBody(src, "LevelTools *__fastcall LevelTools::getAudioFileName("));
    const artistNames = switchStrings(functionBody(src, "LevelTools *__fastcall LevelTools::nameForArtist("));
    const artistUrls = switchStrings(functionBody(src, "LevelTools *__fastcall LevelTools::ngURLForArtist("));
    const songUrls = switchStrings(functionBody(src, "LevelTools *__fastcall LevelTools::urlForAudio("));
    const getLevel = functionBody(src, "GJGameLevel *__fastcall LevelTools::getLevel(");
    const facts = levelFacts(getLevel);
    const named = namedLevelFacts(getLevel);
    const colours = playerColours(functionBody(src, "int __fastcall GameManager::colorForIdx("));
    const rewards = achievementRewards(functionBody(src, "int __fastcall AchievementManager::getAchievementRewardDict("));
    const thresholds = achievementThresholds(functionBody(src, "int *__fastcall GameStatsManager::checkAchievement("));
    const reports = levelReports(
      functionBody(src, "int *__fastcall GameManager::reportPercentageForLevel("),
      functionBody(src, "int *__fastcall GameStatsManager::checkCoinAchievement("),
    );
    const pulses = songPulses(functionBody(src, "LevelTools *__fastcall LevelTools::getAudioString("), readFileSync(exePath(ctx)));
    for (let i = 0; i <= 19; i++) if (!pulses[i]) throw new Error(`song ${i} has no beat script`);
    if (colours.length < 100) throw new Error(`the player colour table came back with ${colours.length} entries`);
    if (rewards.size < 200) throw new Error(`the achievement reward table came back with ${rewards.size} entries`);
    const achievements: Record<string, AchievementFacts> = {};
    for (const id of new Set([...rewards.keys(), ...thresholds.keys(), ...reports])) {
      const t = thresholds.get(id);
      achievements[id] = { stat: t?.stat ?? null, threshold: t?.threshold ?? null, reward: rewards.get(id) ?? null };
    }
    gaps.push("achievement titles and descriptions: AchievementManager::addManualAchievements did not decompile, and the strings are not in the exe either");

    // artistForAudio indexes a byte array the pseudo-C does not carry, so the
    // song-to-artist link cannot be recovered from this file.
    gaps.push("song to artist: LevelTools::artistForAudio reads byte_981284, which the decompile does not include");

    const songs: StringsFile["songs"] = {};
    for (const [index, title] of titles) {
      if (index < 0) continue;
      const file = files.get(index);
      if (!file) {
        gaps.push(`song ${index} (${title}) has a title but no file name`);
        continue;
      }
      const info: SongInfo = { title, file, artist: null, url: songUrls.get(index) ?? null };
      songs[index] = info;
    }

    const artists: StringsFile["artists"] = {};
    for (const [index, name] of artistNames) artists[index] = { name, url: artistUrls.get(index) ?? null };

    // The main twenty-two are offset by one — `getLevel` for Clubstep, id 14,
    // opens with `getAudioTitle(13)` — and are named for their song. The
    // Challenge and the floors have branches of their own, named for the level.
    const levels: StringsFile["levels"] = {};
    for (const id of LEVEL_IDS) {
      const own = named.get(id);
      const f = own ?? (id >= 1 && id <= 22 ? facts.get(id - 1) : undefined);
      if (!f) {
        gaps.push(`level ${id} has no branch in getLevel`);
        continue;
      }
      levels[id] = own ?? { ...f, name: songs[f.song]?.title ?? "" };
    }

    if (tips.size < 20) throw new Error(`only ${tips.size} loading tips were read; the table shape must have changed`);
    if (Object.keys(songs).length < 22) throw new Error(`only ${Object.keys(songs).length} songs were read`);

    const out: StringsFile = {
      version: 1,
      playerColours: colours,
      achievements,
      loadingTips: Object.fromEntries(tips),
      songs,
      songPulses: pulses,
      artists,
      levels,
      gaps,
    };
    const w = writeJson(dest, out);
    return {
      files: w.written ? 1 : 0,
      bytes: w.bytes,
      skipped: w.written ? 0 : 1,
      summary:
        `${tips.size} tips  ${Object.keys(songs).length} songs  ` +
        `${Object.keys(artists).length} artists  ${Object.keys(levels).length} levels`,
      outputs: [rel],
    };
  },
};
