// The save layer, fed the things that actually happen to stored data: absent,
// empty, truncated, the wrong type, from a version that does not exist yet.
// None of them may throw, and none may lose more than the field at fault.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OnlineLevel } from "../src/online/api";
import { defaultSave, defaultSettings, emptyProgress, SAVE_KEY, SAVED_LEVELS_MAX, totalAttempts, totalCoins, totalStars, type LevelProgress, type SaveV1 } from "../src/save/schema";
import { migrate, SaveStore, type KeyValueStore } from "../src/save/store";
import { achieved, achievementProgress, availability, describeAchievement, freeByDefault, parseReward, progressOf, type Progress } from "../src/save/unlocks";

class Memory implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** A store that refuses everything, like a browser with site data blocked. */
class Hostile implements KeyValueStore {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
  removeItem(): void {
    throw new Error("blocked");
  }
}

function saved(store: Memory): SaveV1 {
  return JSON.parse(store.getItem(SAVE_KEY) ?? "{}") as SaveV1;
}

test("nothing stored is a fresh save, not an error", () => {
  const store = new SaveStore(new Memory());
  assert.equal(store.get().version, 1);
  assert.deepEqual(store.get().levels, {});
});

test("garbage in storage starts fresh and keeps the unreadable text aside", () => {
  const memory = new Memory();
  memory.setItem(SAVE_KEY, "{not json at all");
  const store = new SaveStore(memory);
  assert.equal(store.get().version, 1);
  assert.equal(memory.getItem(`${SAVE_KEY}:unreadable`), "{not json at all");
});

test("a storage that throws on every call still gives a working save", () => {
  const store = new SaveStore(new Hostile());
  assert.equal(store.get().version, 1);
  store.set((s) => {
    s.settings.musicVolume = 0.5;
  });
  store.flush();
  assert.equal(store.get().settings.musicVolume, 0.5, "it is still right in memory");
});

test("migrate survives everything that is not an object", () => {
  for (const bad of [null, undefined, 0, "", "text", [], true]) {
    const out = migrate(bad);
    assert.equal(out.version, 1, `${JSON.stringify(bad)} did not migrate`);
    assert.ok(out.settings, "and has settings");
  }
});

test("a half-written save keeps what is readable and defaults the rest", () => {
  const out = migrate({ version: 1, levels: { "1": { best: 62 } }, settings: { musicVolume: 0.25 } });
  assert.equal(out.levels["1"].best, 62);
  assert.equal(out.levels["1"].attempts, 0, "a missing field defaults");
  assert.deepEqual(out.levels["1"].coins, [false, false, false]);
  assert.equal(out.settings.musicVolume, 0.25);
  assert.equal(out.settings.sfxVolume, 1, "the other settings are still there");
});

test("a field of the wrong type is replaced, not carried", () => {
  const out = migrate({
    version: 1,
    levels: { "1": { best: "lots", attempts: null, coins: "yes" } },
    settings: { musicVolume: "loud", autoRetry: 1 },
    player: { colour1: {}, glow: "true" },
  });
  assert.equal(out.levels["1"].best, 0);
  assert.equal(out.levels["1"].attempts, 0);
  assert.deepEqual(out.levels["1"].coins, [false, false, false]);
  assert.equal(out.settings.musicVolume, 1);
  assert.equal(out.settings.autoRetry, true);
  assert.equal(out.player.glow, false);
});

test("a NaN or out-of-range percentage is clamped rather than stored", () => {
  const out = migrate({ version: 1, levels: { "1": { best: Number.NaN }, "2": { best: 400 }, "3": { best: -5 } } });
  assert.equal(out.levels["1"].best, 0);
  assert.equal(out.levels["2"].best, 100);
  assert.equal(out.levels["3"].best, 0);
});

test("a save from a version that does not exist keeps what this one understands", () => {
  const out = migrate({ version: 99, levels: { "5": { best: 30 } }, somethingNew: { a: 1 } });
  assert.equal(out.version, 1);
  assert.equal(out.levels["5"].best, 30);
  assert.ok(!("somethingNew" in out), "unknown keys are dropped rather than carried");
});

test("a level key that is not a level id is dropped", () => {
  const out = migrate({ version: 1, levels: { "1": { best: 10 }, "__proto__": { best: 90 }, notanid: { best: 50 } } });
  assert.deepEqual(Object.keys(out.levels), ["1"]);
});

test("an attempt records the attempt and only improves the best", () => {
  const store = new SaveStore(new Memory());
  assert.equal(store.recordAttempt(1, 40, false), true);
  assert.equal(store.recordAttempt(1, 20, false), false, "a worse run is not a new best");
  assert.equal(store.level(1).best, 40);
  assert.equal(store.level(1).attempts, 2);
  assert.equal(store.level(1).completions, 0);
});

test("finishing counts a completion and stamps the first time only", () => {
  const store = new SaveStore(new Memory());
  store.recordAttempt(1, 100, false);
  const first = store.level(1).firstCompletedAt;
  assert.ok(first, "the first completion is stamped");
  store.recordAttempt(1, 100, false);
  assert.equal(store.level(1).completions, 2);
  assert.equal(store.level(1).firstCompletedAt, first, "and not re-stamped");
});

test("practice keeps its own best and never counts as completing the level", () => {
  const store = new SaveStore(new Memory());
  store.recordAttempt(1, 100, true);
  assert.equal(store.level(1).practiceBest, 100);
  assert.equal(store.level(1).best, 0);
  assert.equal(store.level(1).completions, 0);
});

test("a flush writes what a reload reads back", () => {
  const memory = new Memory();
  const store = new SaveStore(memory);
  store.recordAttempt(7, 55, false);
  store.set((s) => {
    s.player.icons.cube = 12;
  });
  store.flush();
  const again = new SaveStore(memory);
  assert.equal(again.level(7).best, 55);
  assert.equal(again.get().player.icons.cube, 12);
});

test("a write is debounced, so an attempt does not serialise the save each time", () => {
  const memory = new Memory();
  const store = new SaveStore(memory);
  store.recordAttempt(1, 10, false);
  assert.equal(memory.getItem(SAVE_KEY), null, "nothing written yet");
  store.flush();
  assert.equal(saved(memory).levels["1"].best, 10);
});

test("a reset empties the save both in memory and in storage", () => {
  const memory = new Memory();
  const store = new SaveStore(memory);
  store.recordAttempt(1, 90, false);
  store.flush();
  store.reset();
  assert.deepEqual(store.get().levels, {});
  assert.equal(memory.getItem(SAVE_KEY), null);
});

test("stars are counted from the levels rather than stored", () => {
  const save = defaultSave();
  save.levels["1"] = { best: 100, practiceBest: 0, attempts: 3, completions: 1, coins: [true, false, true] };
  save.levels["2"] = { best: 60, practiceBest: 0, attempts: 9, completions: 0, coins: [false, false, false] };
  const stars = totalStars(save, (id) => (id === 1 ? 1 : 2));
  assert.equal(stars, 1, "only a completed level awards its stars");
  assert.equal(totalCoins(save), 2);
});

// --- what has been earned ----------------------------------------------------
// The unlock rules: the free set from the binary, the rest from the
// achievement table, and an honest "not here" for what the port cannot count.

const FACTS = {
  stars: { stat: 6, threshold: 500, reward: "ship_04" },
  coins: { stat: 8, threshold: 19, reward: "icon_43" },
  jumps: { stat: 1, threshold: 1000, reward: "bird_09" },
  level: { stat: null, threshold: null, reward: "color_13" },
  iconsDestroyed: { stat: 9, threshold: 50, reward: "dart_08" },
};
const TABLE = [
  { id: "geometry.ach.stars05", ...FACTS.stars },
  { id: "geometry.ach.coins19", ...FACTS.coins },
  { id: "geometry.ach.jump01", ...FACTS.jumps },
  { id: "geometry.ach.level01a", ...FACTS.level },
  { id: "geometry.ach.secret02", ...FACTS.iconsDestroyed },
];

function progressWith(over: Partial<Progress>): Progress {
  return {
    stars: 0,
    secretCoins: 0,
    demons: 0,
    attempts: 0,
    jumps: 0,
    completed: new Set(),
    practised: new Set(),
    levels: new Map(),
    nearMiss: false,
    menuKills: 0,
    earned: new Set(),
    ...over,
  };
}

test("reward strings use the game's own names for the modes", () => {
  assert.deepEqual(parseReward("icon_43"), { kind: "cube", index: 43 });
  assert.deepEqual(parseReward("bird_09"), { kind: "ufo", index: 9 });
  assert.deepEqual(parseReward("dart_11"), { kind: "wave", index: 11 });
  assert.deepEqual(parseReward("color2_25"), { kind: "colour2", index: 25 });
  assert.equal(parseReward("nothing"), null);
  assert.equal(parseReward(null), null);
});

test("the free set is cubes 1 to 4, the first of everything else, and four colours", () => {
  for (let i = 1; i <= 4; i++) assert.equal(freeByDefault("cube", i), true, `cube ${i}`);
  assert.equal(freeByDefault("cube", 5), false);
  assert.equal(freeByDefault("ship", 1), true);
  assert.equal(freeByDefault("ship", 2), false);
  assert.equal(freeByDefault("colour1", 3), true);
  assert.equal(freeByDefault("colour1", 4), false);
  assert.equal(freeByDefault("colour2", 0), true);
});

test("a countable achievement is decided by the save; the rest are not decided at all", () => {
  const short = progressWith({ stars: 499, secretCoins: 19, jumps: 999 });
  assert.equal(achieved("geometry.ach.stars05", FACTS.stars, short), false);
  assert.equal(achieved("geometry.ach.coins19", FACTS.coins, short), true);
  assert.equal(achieved("geometry.ach.jump01", FACTS.jumps, short), false);
  assert.equal(achieved("geometry.ach.stars05", FACTS.stars, progressWith({ stars: 500 })), true);
  assert.equal(achieved("geometry.ach.secret02", FACTS.iconsDestroyed, short), false, "stat 9 counts the icons destroyed on the menu");
  assert.equal(achieved("geometry.ach.secret02", FACTS.iconsDestroyed, progressWith({ menuKills: 50 })), true);
  // `a` is the practice one and `b` the normal one.
  // [gdp GameManager::reportPercentageForLevel :116726-116838, :116844-117027]
  assert.equal(achieved("geometry.ach.level01b", FACTS.level, progressWith({ completed: new Set([1]) })), true);
  assert.equal(achieved("geometry.ach.level01a", FACTS.level, progressWith({ completed: new Set([1]) })), false, "a is practice");
  assert.equal(achieved("geometry.ach.level01a", FACTS.level, progressWith({ practised: new Set([1]) })), true);
});

test("availability names the achievement that earns a locked item", () => {
  const nothing = progressWith({});
  assert.deepEqual(availability("ship", 4, TABLE, nothing), { state: "locked", achievement: "geometry.ach.stars05" });
  assert.deepEqual(availability("ship", 4, TABLE, progressWith({ stars: 500 })), { state: "unlocked" });
  assert.deepEqual(availability("cube", 2, TABLE, nothing), { state: "unlocked" }, "free by default");
  assert.deepEqual(availability("wave", 8, TABLE, nothing), { state: "locked", achievement: "geometry.ach.secret02" }, "behind the menu's icons");
  assert.deepEqual(availability("wave", 8, TABLE, progressWith({ menuKills: 50 })), { state: "unlocked" });
  assert.deepEqual(availability("robot", 7, TABLE, nothing), { state: "elsewhere" }, "nothing here awards it");
});

test("an achievement is described by what it is, since the game's titles are not to be had", () => {
  const name = (id: number): string => (id === 1 ? "Stereo Madness" : `Level ${id}`);
  assert.equal(describeAchievement("geometry.ach.stars05", FACTS.stars, name), "Collect 500 stars");
  assert.equal(describeAchievement("geometry.ach.jump01", FACTS.jumps, name), "Jump 1,000 times");
  assert.equal(describeAchievement("geometry.ach.level01a", FACTS.level, name), "Complete Stereo Madness in practice");
  assert.equal(describeAchievement("geometry.ach.level01b", FACTS.level, name), "Complete Stereo Madness");
  assert.equal(describeAchievement("geometry.ach.secret02", FACTS.iconsDestroyed, name), "Tap 50 icons as they run past on the main menu");
});

test("the menu's icons count when they are destroyed, and cubes 55 and 50 earn their own", () => {
  const NONE = { stat: null, threshold: null, reward: null };
  const store = new SaveStore(new Memory());
  store.recordMenuKill(null);
  assert.equal(store.get().totals.menuKills, 1);
  assert.equal(achieved("geometry.ach.secret11", NONE, progressOf(store.get(), () => 0, () => false)), false);
  store.recordMenuKill("geometry.ach.secret11");
  store.recordMenuKill("geometry.ach.secret11");
  assert.equal(store.get().totals.menuKills, 3);
  assert.deepEqual(store.get().totals.earned, ["geometry.ach.secret11"], "kept once");
  const p = progressOf(store.get(), () => 0, () => false);
  assert.equal(achieved("geometry.ach.secret11", NONE, p), true);
  assert.equal(achieved("geometry.ach.secret12", NONE, p), false);
  assert.equal(achieved("geometry.ach.secret10", NONE, p), null, "other secrets are still not decidable");
  const kept = migrate(JSON.parse(JSON.stringify(store.get())));
  assert.equal(kept.totals.menuKills, 3);
  assert.deepEqual(kept.totals.earned, ["geometry.ach.secret11"]);
  assert.deepEqual(migrate({ totals: { earned: ["x", 4, "geometry.ach.secret12"] } }).totals.earned, ["geometry.ach.secret12"]);
});

test("progress is read off the levels rather than stored", () => {
  const save = defaultSave();
  save.levels["1"] = { best: 100, practiceBest: 100, attempts: 12, completions: 1, coins: [true, false, true] };
  save.levels["14"] = { best: 100, practiceBest: 0, attempts: 300, completions: 2, coins: [false, false, false] };
  save.totals.jumps = 77;
  const p = progressOf(save, (id) => (id === 1 ? 1 : id === 14 ? 10 : 0), (id) => id === 14);
  assert.equal(p.stars, 11);
  assert.equal(p.secretCoins, 2);
  assert.equal(p.demons, 1);
  assert.equal(p.attempts, 312);
  assert.equal(p.jumps, 77);
  assert.deepEqual([...p.completed].sort(), [1, 14]);
  assert.deepEqual([...p.practised], [1]);
  assert.equal(p.levels.get(14)?.best, 100);
  assert.equal(p.nearMiss, false);
});

test("a save from before the jump total was kept comes back with zero, not a crash", () => {
  const store = new SaveStore(new Memory());
  const raw = JSON.parse(JSON.stringify(defaultSave())) as Record<string, unknown>;
  delete raw.totals;
  const migrated = migrate(raw);
  assert.equal(migrated.totals.jumps, 0);
  assert.ok(store.get().totals.jumps === 0);
});

// --- the achievements about one level, and what a run leaves behind ----------

const LEVEL_NAMES: Record<number, string> = { 1: "Stereo Madness", 14: "Clubstep", 5001: "The Tower", 5002: "The Sewers" };
const levelName = (id: number): string => LEVEL_NAMES[id] ?? `Level ${id}`;
const NO_FACTS = { stat: null, threshold: null, reward: null };

function withLevel(id: number, over: Partial<LevelProgress>): Map<number, LevelProgress> {
  return new Map([[id, { ...emptyProgress(), ...over }]]);
}

test("the floors, the coin sets and special01 are decided per level", () => {
  // [gdp GameManager::reportPercentageForLevel :116839-116843 (special01),
  //  :116855-116874 (the floors); GameStatsManager::checkCoinAchievement
  //  :342729-342830]
  assert.equal(achieved("geometry.ach.tower01", NO_FACTS, progressWith({ completed: new Set([5001]) })), true);
  assert.equal(achieved("geometry.ach.tower02", NO_FACTS, progressWith({ completed: new Set([5001]) })), false);
  assert.equal(describeAchievement("geometry.ach.tower01", NO_FACTS, levelName), "Complete The Tower");

  const two = progressWith({ levels: withLevel(14, { coins: [true, false, true] }) });
  assert.equal(achieved("geometry.ach.demoncoin01", NO_FACTS, two), false);
  assert.equal(achievementProgress("geometry.ach.demoncoin01", NO_FACTS, two), 2 / 3);
  const three = progressWith({ levels: withLevel(14, { coins: [true, true, true] }) });
  assert.equal(achieved("geometry.ach.demoncoin01", NO_FACTS, three), true);
  assert.equal(achievementProgress("geometry.ach.demoncoin01", NO_FACTS, three), 1);
  assert.equal(describeAchievement("geometry.ach.demoncoin01", NO_FACTS, levelName), "Collect all 3 secret coins in Clubstep");

  const sewers = progressWith({ levels: withLevel(5002, { coins: [true, true, true] }) });
  assert.equal(achieved("geometry.ach.tower02Coin", NO_FACTS, sewers), true);
  assert.equal(describeAchievement("geometry.ach.tower02Coin", NO_FACTS, levelName), "Collect all 3 secret coins in The Sewers");

  assert.equal(achieved("geometry.ach.special01", NO_FACTS, progressWith({})), false);
  assert.equal(achieved("geometry.ach.special01", NO_FACTS, progressWith({ nearMiss: true })), true);
  assert.equal(describeAchievement("geometry.ach.special01", NO_FACTS, levelName), "Crash at 95% to 99% in normal mode");

  assert.equal(achievementProgress("geometry.ach.level03b", NO_FACTS, progressWith({ levels: withLevel(3, { best: 57 }) })), 0.57);
  assert.equal(achievementProgress("geometry.ach.level03a", NO_FACTS, progressWith({ levels: withLevel(3, { practiceBest: 80 }) })), 0.8);

  // Reported, but about parts of the game that are not here.
  for (const id of ["geometry.ach.subzero.level001", "geometry.ach.world.level001b", "geometry.ach.mdlevel01b"]) {
    assert.equal(achieved(id, NO_FACTS, progressWith({ completed: new Set([1, 1001, 2001, 4001]) })), null, id);
  }
});

test("availability follows the swap: a normal clear gives the b reward", () => {
  const table = [
    { id: "geometry.ach.level01b", stat: null, threshold: null, reward: "icon_05" },
    { id: "geometry.ach.level01a", stat: null, threshold: null, reward: "color_04" },
  ];
  const cleared = progressWith({ completed: new Set([1]) });
  assert.deepEqual(availability("cube", 5, table, cleared), { state: "unlocked" });
  assert.deepEqual(availability("colour1", 4, table, cleared), { state: "locked", achievement: "geometry.ach.level01a" });
});

test("a normal death at 95 to 99 % is remembered", () => {
  const store = new SaveStore(new Memory());
  store.recordAttempt(5, 94, false);
  assert.equal(store.get().totals.nearMiss, false);
  store.recordAttempt(5, 96, true);
  assert.equal(store.get().totals.nearMiss, false, "not in practice");
  store.recordAttempt(5, 100, false);
  assert.equal(store.get().totals.nearMiss, false, "not by a completion");
  store.recordAttempt(5, 99, false);
  assert.equal(store.get().totals.nearMiss, true);
  store.recordAttempt(5, 100, false);
  assert.equal(store.get().totals.nearMiss, true, "and it stays");
});

test("an old save's near miss is read off its bests", () => {
  assert.equal(migrate({ version: 1, levels: { "4": { best: 97 } } }).totals.nearMiss, true);
  assert.equal(migrate({ version: 1, levels: { "4": { best: 100 } } }).totals.nearMiss, false);
  // A tower floor's best of 97 is left from when this port kept a platformer
  // death's percentage; the game reports none. [gdp PlayLayer::destroyPlayer
  //  :93205-93211 skips :93240-93254]
  assert.equal(migrate({ version: 1, levels: { "5001": { best: 97 } } }).totals.nearMiss, false, "not a platformer's");
  const kept = migrate({ totals: { jumps: 3, nearMiss: true } });
  assert.equal(kept.totals.nearMiss, true);
  assert.equal(kept.totals.jumps, 3);
});

test("a completion keeps its coins by their own number", () => {
  // [gdp GJBaseGameLayer::processItems :420676-420763, getCoinKey :269911-269930]
  const store = new SaveStore(new Memory());
  store.recordAttempt(22, 100, false, [2, 3]);
  assert.deepEqual(store.level(22).coins, [false, true, true]);
  store.recordAttempt(22, 100, false, [1]);
  assert.deepEqual(store.level(22).coins, [true, true, true]);
});

test("only a normal completion keeps coins", () => {
  // [gdp PlayLayer::levelComplete :92815-92848, outside practice only]
  const store = new SaveStore(new Memory());
  store.recordAttempt(22, 100, true, [1]);
  assert.deepEqual(store.level(22).coins, [false, false, false]);
  store.recordAttempt(22, 64, false, [1]);
  assert.deepEqual(store.level(22).coins, [false, false, false]);
});

test("a coin number outside 1 to 3 is dropped", () => {
  const store = new SaveStore(new Memory());
  store.recordAttempt(22, 100, false, [0, 4, 1]);
  assert.deepEqual(store.level(22).coins, [true, false, false]);
});

// --- online levels -------------------------------------------------------------

function onlineLevel(id: number, name = `Level ${id}`): OnlineLevel {
  return {
    id, name, description: "", author: "someone", face: 3, stars: 0, demon: false, featured: false, epic: 0,
    downloads: 10, likes: 2, length: 1, coins: 0, verifiedCoins: false, twoPlayer: false, objects: 100, version: 1,
    song: { kind: "official", index: 0 },
  };
}

test("an online level's progress is kept apart from the official level with the same id", () => {
  const store = new SaveStore(new Memory());
  store.recordAttempt(3001, 100, false, [1], true);
  assert.equal(store.onlineLevel(3001).completions, 1);
  assert.deepEqual(store.onlineLevel(3001).coins, [true, false, false]);
  assert.equal(store.level(3001).attempts, 0, "The Challenge is untouched");
  assert.equal(totalCoins(store.get()), 0, "a user coin is no secret coin");
  assert.equal(totalAttempts(store.get()), 1, "but the attempt counts");
});

test("the saved list puts the newest first, keeps one of each, and stops at its limit", () => {
  const store = new SaveStore(new Memory());
  store.saveOnlineLevel(onlineLevel(1));
  store.saveOnlineLevel(onlineLevel(2));
  store.saveOnlineLevel(onlineLevel(1, "Renamed"));
  assert.deepEqual(store.get().savedLevels.map((l) => l.id), [1, 2]);
  assert.equal(store.get().savedLevels[0].name, "Renamed");
  for (let i = 10; i < 10 + SAVED_LEVELS_MAX; i++) store.saveOnlineLevel(onlineLevel(i));
  assert.equal(store.get().savedLevels.length, SAVED_LEVELS_MAX);
  assert.ok(!store.isSaved(2), "the oldest fell off the end");
  store.forgetOnlineLevel(12);
  assert.ok(!store.isSaved(12));
});

test("saved online levels survive a reload and junk in them is dropped", () => {
  const out = migrate({
    version: 1,
    online: { "77": { best: 40 }, nope: { best: 1 } },
    savedLevels: [onlineLevel(77), { id: -4 }, "x", { ...onlineLevel(78), face: 99, song: { kind: "custom", id: 5, name: "A", artist: "B" } }, onlineLevel(77)],
  });
  assert.equal(out.online["77"].best, 40);
  assert.deepEqual(Object.keys(out.online), ["77"]);
  assert.deepEqual(out.savedLevels.map((l) => l.id), [77, 78]);
  assert.equal(out.savedLevels[1].face, 10, "clamped");
  assert.deepEqual(out.savedLevels[1].song, { kind: "custom", id: 5, name: "A", artist: "B", available: true });
  assert.deepEqual(migrate({ version: 1 }).savedLevels, [], "an old save gains an empty list");
});

test("a fresh save hides the percentage and the progress bar", () => {
  // [gdp GameManager::firstLoad :114397-114426: +668 = 0, gv 0040 never set]
  assert.equal(defaultSettings().showPercentage, false);
  assert.equal(defaultSettings().showProgressBar, false);
  const out = migrate({ version: 1, settings: { showPercentage: true } });
  assert.equal(out.settings.showPercentage, true, "a stored choice is kept");
  assert.equal(out.settings.showProgressBar, false);
});
