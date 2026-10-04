// The audio layer's decisions, tested where they are decidable without a
// browser: what a simulation event sounds like, the drain that reads the
// event lists once each, and the pure pieces of the game's audio — the
// semitone table, where a song is at a music time, a tween part-way through,
// proximity volume and the pitch shift. What a whole level sounds like is in
// levelAudio.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { settleWithin } from "../src/audio/engine";
import { EventDrain, type SoundSink } from "../src/audio/events";
import { EVENT_SOUNDS, musicPath, PRACTICE_MUSIC, songPath, triggerSfxName, UI_SOUNDS } from "../src/audio/names";
import { PITCH_RATIOS, pitchForIdx } from "../src/audio/pitch";
import { pitchShift } from "../src/audio/pitchShift";
import { minDistance, proximityFor, proximityVolume, type ProximityWorld } from "../src/audio/proximity";
import { levelSongPositionMs, songPositionMs, songState, tweenAt } from "../src/audio/songState";
import { audioParams, sfxRefId, uniqueSfxId, type AudioTriggerParams } from "../src/audio/triggerAudio";
import type { Sim, SimEvent } from "../src/physics/types";
import type { TriggerEvent } from "../src/triggers/runtime";
import { LEVELS_DIR, loadOfficialLevel, builtPath } from "./helpers";
import { buildLevel } from "./levelKit";

const ASSETS = builtPath("assets/audio");
const SFX = join(ASSETS, "sfx");
const SKIP = existsSync(SFX) ? false : "run `npm run assets` first";
const LEVELS = existsSync(`${LEVELS_DIR}/1.txt`) ? false : "needs the real install";

class Recorder implements SoundSink {
  readonly effects: Array<[string, number]> = [];
  readonly triggers: TriggerEvent[] = [];
  effect(name: string, volume: number): void {
    this.effects.push([name, volume]);
  }
  trigger(e: TriggerEvent): void {
    this.triggers.push(e);
  }
  get played(): string[] {
    return this.effects.map(([name]) => name);
  }
}

/** Just enough of a Sim for the drain: two append-only lists it can truncate, the options and the end. */
function fakeSim(): { sim: Sim; sounds: SimEvent[]; triggers: TriggerEvent[]; options: { noDeathSfx: boolean; audioOnDeath: boolean } } {
  const sounds: SimEvent[] = [];
  const triggers: TriggerEvent[] = [];
  const options = { noDeathSfx: false, audioOnDeath: false };
  const sim = { events: sounds, end: null, triggers: { events: triggers, musicTime: 0, visual: { options } } } as unknown as Sim;
  return { sim, sounds, triggers, options };
}

function died(tick: number): SimEvent {
  return { tick, type: "die", player: 1 };
}

function finished(tick: number): SimEvent {
  return { tick, type: "finish", player: 1 };
}

test("every simulation event says what it sounds like, including silence", () => {
  const types: SimEvent["type"][] = [
    "jump", "land", "orb", "pad", "portal", "flip",
    "dashStart", "dashEnd", "die", "finish", "collect", "checkpoint", "break",
  ];
  for (const type of types) {
    const rule = EVENT_SOUNDS[type];
    assert.ok(rule, `${type} has no entry`);
    // A silent event has to say why, so it reads as a decision rather than a gap.
    if (rule.sfx === null) assert.ok(rule.why && rule.why.length > 0, `${type} is silent with no reason given`);
  }
});

test("the loud events are the two the game actually plays", () => {
  // A pickup plays nothing. [gdp GJBaseGameLayer::pickupItem :420607,
  //  collectedObject :459006]
  const loud = Object.entries(EVENT_SOUNDS)
    .filter(([, rule]) => rule.sfx !== null)
    .map(([type]) => type)
    .sort();
  assert.deepEqual(loud, ["die", "finish"]);
});

test("an SFX trigger's id is its file name", () => {
  assert.equal(triggerSfxName(10117), "s10117");
  assert.equal(triggerSfxName(1032), "s1032");
});

test("a custom song is Ogg from the music library and mp3 from Newgrounds", () => {
  // [gdp MusicDownloadManager::pathForSong :394118-394141]
  assert.equal(songPath(10003039, "ogg"), "audio/songs/10003039.ogg");
  assert.equal(songPath(10003039, "m4a"), "audio/songs/10003039.m4a");
  assert.equal(songPath(6, "ogg"), "audio/songs/6.mp3");
  assert.equal(musicPath(PRACTICE_MUSIC), "audio/music/StayInsideMe.mp3");
});

test("every sound this port names is a file the build shipped", { skip: SKIP }, () => {
  // Naming a file the library does not have is the quiet failure here: nothing
  // throws, the sound simply never plays.
  const named = [
    ...Object.values(EVENT_SOUNDS).map((r) => r.sfx),
    ...Object.values(UI_SOUNDS),
  ].filter((n): n is string => n !== null);
  for (const name of named) {
    assert.ok(existsSync(join(SFX, `${name}.ogg`)), `${name}.ogg is not in the build`);
  }
  assert.ok(existsSync(join(ASSETS, "music", PRACTICE_MUSIC)), "the practice track is not in the build");
});

test("the SFX library the triggers index is shipped whole", { skip: SKIP }, () => {
  // The official levels' SFX triggers index it by id, so a partial copy shows
  // up as silence in the Tower floors rather than as an error.
  const files = readdirSync(SFX).filter((f) => /^s\d+\.ogg$/.test(f));
  assert.ok(files.length >= 250, `only ${files.length} library effects shipped`);
});

// --- the drain ----------------------------------------------------------------

test("each event is played once, however many times the frame drains", () => {
  const { sim, sounds } = fakeSim();
  const drain = new EventDrain();
  const out = new Recorder();
  sounds.push(died(10));
  drain.drain(sim, out);
  drain.drain(sim, out);
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11"]);
});

test("a rewind snaps the cursor back, and what follows it plays once", () => {
  const { sim, sounds } = fakeSim();
  const drain = new EventDrain();
  const out = new Recorder();

  sounds.push({ tick: 5, type: "checkpoint", player: 1 });
  drain.drain(sim, out);
  const mark = sounds.length;

  sounds.push(died(60));
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11"]);

  // Restore: the sim truncates its own list back to the checkpoint.
  sounds.length = mark;
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11"], "a rewind on its own is silent");

  sounds.push(died(62));
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11", "explode_11"]);
});

test("a restart forgets the cursor so the level sounds the same the second time", () => {
  const { sim, sounds } = fakeSim();
  const drain = new EventDrain();
  const out = new Recorder();
  sounds.push(died(10));
  drain.drain(sim, out);
  drain.reset();
  sounds.length = 0;
  sounds.push(died(10));
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11", "explode_11"]);
});

test("a skip takes everything so far as heard", () => {
  const { sim, sounds, triggers } = fakeSim();
  const drain = new EventDrain();
  const out = new Recorder();
  sounds.push(died(10));
  triggers.push({ tick: 10, kind: "sfx", id: 5, object: 3, at: 0.1 });
  drain.skip(sim);
  drain.drain(sim, out);
  assert.deepEqual(out.effects, []);
  assert.deepEqual(out.triggers, []);
});

test("both players hitting the same thing on one tick is one sound", () => {
  const { sim, sounds } = fakeSim();
  const drain = new EventDrain();
  const out = new Recorder();
  sounds.push({ tick: 12, type: "die", player: 1 }, { tick: 12, type: "die", player: 2 });
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11"]);
});

test("the same effect on two different ticks is two sounds", () => {
  const { sim, sounds } = fakeSim();
  const drain = new EventDrain();
  const out = new Recorder();
  sounds.push(died(12), died(13));
  drain.drain(sim, out);
  assert.deepEqual(out.played, ["explode_11", "explode_11"]);
});

test("the death sound is 0.65 and key 576 silences it", () => {
  // [gdp PlayLayer::destroyPlayer :93293-93297]
  const loud = fakeSim();
  const out = new Recorder();
  loud.sounds.push(died(4));
  new EventDrain().drain(loud.sim, out);
  assert.deepEqual(out.effects, [["explode_11", 0.65]]);

  const quiet = fakeSim();
  const none = new Recorder();
  quiet.options.noDeathSfx = true;
  quiet.sounds.push(died(4));
  new EventDrain().drain(quiet.sim, none);
  assert.deepEqual(none.effects, []);
});

test("the pickup is silent", () => {
  const { sim, sounds } = fakeSim();
  const out = new Recorder();
  sounds.push({ tick: 3, type: "collect", player: 1 });
  new EventDrain().drain(sim, out);
  assert.deepEqual(out.effects, []);
});

test("the end sound plays at 1, and practice has none", () => {
  // Practice never reaches the complete effect the sound belongs to.
  // [gdp PlayLayer::levelComplete :92891-92898; showCompleteEffect :88863-88866]
  const normal = fakeSim();
  const out = new Recorder();
  normal.sounds.push(finished(9));
  new EventDrain().drain(normal.sim, out, false);
  assert.deepEqual(out.effects, [["endStart_02", 1]]);

  const practice = fakeSim();
  const none = new Recorder();
  practice.sounds.push(finished(9));
  new EventDrain().drain(practice.sim, none, true);
  assert.deepEqual(none.effects, []);
});

test("audio triggers reach the sink every time they fire, one trigger twice in a tick too; other trigger events do not", () => {
  // Two Spawn triggers spawning an SFX's group in one tick play it twice.
  // [gdp activateSFXTrigger :447147-447225 → playSFXTrigger :108930-109007]
  const { sim, triggers } = fakeSim();
  const out = new Recorder();
  triggers.push(
    { tick: 3, kind: "sfx", id: 10117, object: 7, at: 0.1 },
    { tick: 3, kind: "sfx", id: 10117, object: 7, at: 0.1 },
    { tick: 3, kind: "sfx", id: 10117, object: 8, at: 0.1 },
    { tick: 4, kind: "song", id: 4, object: 9, at: 0.2 },
    { tick: 5, kind: "shader", id: 2919 },
    { tick: 6, kind: "songEdit", id: 0, object: 10, at: 0.3 },
    { tick: 6, kind: "sfxEdit", id: 0, object: 11, at: 0.3 },
  );
  new EventDrain().drain(sim, out);
  assert.deepEqual(
    out.triggers.map((e) => [e.kind, e.object]),
    [["sfx", 7], ["sfx", 7], ["sfx", 8], ["song", 9], ["songEdit", 10], ["sfxEdit", 11]],
  );
});

// --- the semitone table -------------------------------------------------------

test("the pitch table is the exe's float32 constants, 1 outside ±12", () => {
  // [gdp FMODAudioEngine::pitchForIdx :64678-64686; GeometryDash.exe 0x140056aec]
  for (let k = -12; k <= 12; k++) {
    assert.equal(pitchForIdx(k), PITCH_RATIOS[k + 12]);
    assert.equal(Math.fround(PITCH_RATIOS[k + 12]), PITCH_RATIOS[k + 12], `index ${k} is a float32`);
  }
  assert.equal(pitchForIdx(0), 1);
  assert.equal(pitchForIdx(13), 1);
  assert.equal(pitchForIdx(-13), 1);
  assert.equal(pitchForIdx(-12), 0.5);
  assert.equal(pitchForIdx(12), 2);
  // The game's +2 is not 2^(2/12).
  assert.equal(pitchForIdx(2), 1.122562050819397);
});

// --- where a song is ----------------------------------------------------------

test("a song's position is its start plus the music time since, at its speed, wrapped by its loop", () => {
  // [gdp processSongState :432553-432797]
  assert.equal(songPositionMs(15000, 2, 12, pitchForIdx(-2), true, 22500), 16408);
  assert.equal(songPositionMs(15000, 2, 12, 1, true, 0), 25000, "no wrap without an end");
  assert.equal(songPositionMs(15000, 2, 30, 1, true, 22500), 20500);
  assert.equal(levelSongPositionMs(0, 2.888504782691598), 2888);
  assert.equal(levelSongPositionMs(1.5, 10), 11500);
  assert.equal(levelSongPositionMs(0, 1.9999999999999942), 2000);
});

test("a tween part-way through: where it is, where it is heading and what is left", () => {
  assert.deepEqual(tweenAt(1, [{ at: 5, to: 0.4, over: 2 }], 6), [0.699999988079071, 0.4000000059604645, 1]);
  assert.deepEqual(tweenAt(1, [{ at: 5, to: 0.4, over: 2 }], 8), [0.4000000059604645, 0.4000000059604645, 0]);
  assert.deepEqual(
    tweenAt(0, [{ at: 3, to: 0, over: 1 }, { at: 3.5, to: 0.75, over: 0.99 }], 4),
    [0.3787878751754761, 0.75, 0.49000000953674316],
  );
  assert.deepEqual(tweenAt(0.5, [], 4), [0.5, 0.5, 0]);
});

test("a song's state follows only the Edit Songs since it started", () => {
  const edit = (at: number, volume: number, over: number) => ({ at, changeSpeed: false, changeVolume: true, speed: 1, volume, duration: over });
  const s = songState(0, 4, 6, 1, 1, [edit(3, 0.2, 0), edit(5, 0.4, 2)]);
  assert.equal(s.positionMs, 2000);
  assert.deepEqual([s.volume, s.volumeTarget, s.volumeLeft], [0.699999988079071, 0.4000000059604645, 1]);
  // A speed edit is integrated by the average of its ramp: 1 s at 1, then a
  // 2 s ramp to 2 (1.5 on average), then 1 s at 2. [:432615-432745]
  const fast = songState(0, 0, 4, 1, 1, [{ at: 1, changeSpeed: true, changeVolume: false, speed: 2, volume: 0, duration: 2 }]);
  assert.equal(fast.positionMs, 6000);
  assert.deepEqual([fast.speed, fast.speedLeft], [2, 0]);
});

// --- proximity ----------------------------------------------------------------

/** 5001 #5758's proximity keys. */
const TOWER_5758 = { near: 1, mid: 0.5, far: 0, d1: 0, d2: 175, d3: 175 };

test("proximity volume ramps near to middle to far", () => {
  // [gdp volumeForProximityEffect :432164-432230]
  assert.deepEqual(
    [-100, 0, 262.5, 525, 787.5, 1050, 2000].map((d) => proximityVolume(TOWER_5758, d)),
    [1, 1, 0.75, 0.5, 0.25, 0, 0],
  );
  const p5760 = { near: 0, mid: 0.45, far: 0.9, d1: 0, d2: 200, d3: 200 };
  assert.deepEqual(
    [-50, 0, 300, 600, 900, 1200, 1500].map((d) => proximityVolume(p5760, d)),
    [0, 0, 0.22499999403953552, 0.44999998807907104, 0.6749999523162842, 0.8999999761581421, 0.8999999761581421],
  );
});

test("the distance to a group is measured seven ways", () => {
  // [gdp GJBaseGameLayer::getMinDistance :431822-432062]
  const members: Array<[number, number]> = [[100, 0], [400, 0]];
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((mode) => minDistance([250, 30], members, 0, mode)),
    [152.9705810546875, 150, -150, -150, 30, -30, 30, 2147500032],
  );
});

function params(over: Partial<AudioTriggerParams>): AudioTriggerParams {
  const o = buildLevel([{ id: 3605, x: 0, y: 0 }]).objects[0];
  return { ...audioParams(o), ...over };
}

test("proximity listens where the trigger says, and an empty group is full volume", () => {
  const p = params({ ...TOWER_5758, target: 187, listenP1: true, distMode: 3 });
  const world = (x: number, disabled = false, members: number[] = [0]): ProximityWorld => ({
    player1: [x, 0],
    player2: null,
    camera: [0, 0],
    members: (g) => (g === 187 ? members : []),
    position: () => [900, 0],
    disabled: () => disabled,
    mainObject: () => -1,
  });
  assert.deepEqual([900, 1162.5, 2000].map((x) => proximityFor(p, world(x))), [1, 0.75, 0]);
  assert.equal(proximityFor(p, world(900, true)), 0, "a member whose group is off is skipped, so the rest is far away");
  assert.equal(proximityFor(p, world(900, false, [])), 1);
  // No listener at all: key 71 names nothing.
  assert.equal(proximityFor({ ...p, listenP1: false, target2: 5 }, world(900)), 1);
});

// --- an audio trigger's keys ----------------------------------------------------

test("a missing volume is silence, and the ref and unique ids follow keys 415 and 416", () => {
  // [gdp SFXTriggerGameObject::customObjectSetup :309589-309596;
  //  getSFXRefID :311876-311884; getUniqueSFXID :311900-311906]
  const plain = audioParams(buildLevel([{ id: 3602, x: 0, y: 0, props: { 392: "5" } }]).objects[0]);
  assert.equal(plain.volume, 0);
  assert.equal(sfxRefId(plain), -0);
  assert.equal(uniqueSfxId(plain), 0);
  const unique = audioParams(buildLevel([{ id: 3602, x: 0, y: 0, props: { 392: "5", 415: "1", 416: "7", 424: "-3", 406: "0.5" } }]).objects[0]);
  assert.deepEqual([sfxRefId(unique), uniqueSfxId(unique), unique.d1, unique.volume], [7, 7, 0, 0.5]);
});

test("the tower floors' audio triggers read as the game reads them", { skip: LEVELS }, async () => {
  const hollow = await loadOfficialLevel(5004);
  const song = audioParams(hollow.objects[2607]);
  assert.deepEqual(
    {
      id: song.id, soundId: song.soundId, volume: song.volume, fadeInMs: song.fadeInMs, endMs: song.endMs, fadeOutMs: song.fadeOutMs,
      loop: song.loop, channel: song.channel, speed: song.speed, startMs: song.startMs, prep: song.prep, loadPrep: song.loadPrep,
    },
    { id: 1934, soundId: 10006086, volume: 0.699999988079071, fadeInMs: 2000, endMs: 125082, fadeOutMs: 2000, loop: true, channel: 0, speed: 1, startMs: 0, prep: false, loadPrep: false },
  );
  const tower = await loadOfficialLevel(5001);
  const edit = audioParams(tower.objects[5758]);
  assert.deepEqual(
    {
      id: edit.id, channel: edit.channel, target: edit.target, listenP1: edit.listenP1, near: edit.near, mid: edit.mid, far: edit.far,
      d1: edit.d1, d2: edit.d2, d3: edit.d3, distMode: edit.distMode, changeVolume: edit.changeVolume, stop: edit.stop, duration: edit.duration,
    },
    { id: 3605, channel: 0, target: 187, listenP1: true, near: 1, mid: 0.5, far: 0, d1: 0, d2: 175, d3: 175, distMode: 3, changeVolume: false, stop: false, duration: 0.5 },
  );
});

// --- key 405 --------------------------------------------------------------------

test("the pitch shift keeps the length and moves the pitch", () => {
  const rate = 44100;
  const n = Math.round(rate * 0.25);
  const sine = new Float32Array(n);
  for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / rate);
  assert.equal(pitchShift([sine], 1, 1024)[0], sine, "ratio 1 is the input");
  for (const window of [1024, 2048] as const) {
    const [out] = pitchShift([sine], pitchForIdx(2), window);
    assert.equal(out.length, n);
    // Zero crossings over the middle half.
    let crossings = 0;
    const from = Math.floor(n / 4);
    const to = Math.floor((3 * n) / 4);
    for (let i = from + 1; i < to; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
    const hz = crossings / 2 / ((to - from) / rate);
    const want = 440 * pitchForIdx(2);
    assert.ok(Math.abs(hz - want) / want < 0.02, `${window}: ${hz.toFixed(1)} Hz, wanted ${want.toFixed(1)}`);
  }
});

// --- starting up when the browser will not let sound play ---------------------

test("a promise that never settles does not hold up whatever is waiting for it", async () => {
  // Firefox with autoplay blocked returns exactly this from AudioContext.resume:
  // not a rejection, which a catch would see, but a promise that never settles.
  // Awaiting one during startup hung the game on "Loading sound" with nothing on
  // screen to click and no way out.
  const never = new Promise<string>(() => {});
  const started = Date.now();
  const answer = await settleWithin(never, 40, "gave up");
  assert.equal(answer, "gave up");
  assert.ok(Date.now() - started < 1000, "and it gave up promptly");
});

test("a promise that settles in time wins, and the timer does not keep the process alive", async () => {
  const quick = Promise.resolve("ready");
  assert.equal(await settleWithin(quick, 10_000, "gave up"), "ready");
  // The 10-second timer above must have been cleared, or `node --test` would
  // sit here waiting for it rather than finishing.
});

test("a rejection still reaches the caller rather than being swallowed by the timeout", async () => {
  const refused = Promise.reject(new Error("blocked"));
  await assert.rejects(() => settleWithin(refused, 1000, "gave up"), /blocked/);
});
