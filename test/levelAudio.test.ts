// What a level sounds like: LevelAudio driven by a real simulation, one tick
// at a time with `update` after each, into recorders standing in for the
// music and effects players. Each test names the game's rule it holds the
// port to.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelPlay, MusicOut, SfxOut, VoicePlay } from "../src/audio/levelAudio";
import { LevelAudio } from "../src/audio/levelAudio";
import { pitchForIdx } from "../src/audio/pitch";
import { GENERIC_REVERB, reverbImpulse, reverbPreset } from "../src/audio/reverb";
import { proximityFor } from "../src/audio/proximity";
import { levelSongPositionMs } from "../src/audio/songState";
import { audioParams } from "../src/audio/triggerAudio";
import type { LevelHeader } from "../src/level/types";
import { NO_INPUT, type PlayerInput, type Sim, type SimSnapshot } from "../src/physics/types";
import { makeSim } from "./helpers";
import { emptyLevel, makeHeader, simOn, type Placed } from "./levelKit";

type Call = [string, ...unknown[]];

class MusicRec implements MusicOut {
  readonly calls: Call[] = [];
  private readonly channels = new Map<number, string>();
  start(channel: number, play: ChannelPlay): void {
    this.calls.push(["start", channel, play]);
    this.channels.set(channel, play.path);
  }
  stop(channel: number): void {
    this.calls.push(["stop", channel]);
    this.channels.delete(channel);
  }
  stopAll(): void {
    this.calls.push(["stopAll"]);
    this.channels.clear();
  }
  pauseAll(): void {
    this.calls.push(["pauseAll"]);
  }
  endLoop(channel: number): void {
    this.calls.push(["endLoop", channel]);
  }
  volume(channel: number, to: number, over: number): void {
    this.calls.push(["volume", channel, to, over]);
  }
  speed(channel: number, to: number, over: number): void {
    this.calls.push(["speed", channel, to, over]);
  }
  volumeMod(channel: number, mod: number): void {
    this.calls.push(["volumeMod", channel, mod]);
  }
  fadeIn(channel: number, seconds: number): void {
    this.calls.push(["fadeIn", channel, seconds]);
  }
  fadeOut(channel: number, seconds: number): void {
    this.calls.push(["fadeOut", channel, seconds]);
  }
  busFadeIn(seconds: number): void {
    this.calls.push(["busFadeIn", seconds]);
  }
  prepare(path: string): void {
    this.calls.push(["prepare", path]);
  }
  playing(channel: number): string | null {
    return this.channels.get(channel) ?? null;
  }
  starts(channel?: number): ChannelPlay[] {
    return this.calls.filter((c) => c[0] === "start" && (channel === undefined || c[1] === channel)).map((c) => c[2] as ChannelPlay);
  }
  named(name: string): Call[] {
    return this.calls.filter((c) => c[0] === name);
  }
}

class SfxRec implements SfxOut {
  readonly calls: Call[] = [];
  private readonly voices = new Set<number>();
  constructor(private readonly lengths: Record<string, number> = {}) {}
  play(voice: number, v: VoicePlay): void {
    this.calls.push(["play", voice, v]);
    this.voices.add(voice);
  }
  stop(voice: number, afterLoop: boolean): void {
    this.calls.push(["stop", voice, afterLoop]);
    if (!afterLoop) this.voices.delete(voice);
  }
  volume(voice: number, to: number, over: number): void {
    this.calls.push(["volume", voice, to, over]);
  }
  speed(voice: number, to: number, over: number): void {
    this.calls.push(["speed", voice, to, over]);
  }
  volumeMod(voice: number, mod: number): void {
    this.calls.push(["volumeMod", voice, mod]);
  }
  groupVolume(group: number, to: number, over: number): void {
    this.calls.push(["groupVolume", group, to, over]);
  }
  groupSpeed(group: number, to: number, over: number): void {
    this.calls.push(["groupSpeed", group, to, over]);
  }
  groupVolumeMod(group: number, mod: number): void {
    this.calls.push(["groupVolumeMod", group, mod]);
  }
  reverbPreset(preset: number): void {
    this.calls.push(["reverbPreset", preset]);
  }
  stopAll(): void {
    this.calls.push(["stopAll"]);
    this.voices.clear();
  }
  effect(name: string, volume: number): void {
    this.calls.push(["effect", name, volume]);
  }
  stopEffects(): void {
    this.calls.push(["stopEffects"]);
  }
  lengthMs(name: string): number {
    return this.lengths[name] ?? 0;
  }
  playing(voice: number): boolean {
    return this.voices.has(voice);
  }
  plays(): Array<[number, VoicePlay]> {
    return this.calls.filter((c) => c[0] === "play").map((c) => [c[1] as number, c[2] as VoicePlay]);
  }
  named(name: string): Call[] {
    return this.calls.filter((c) => c[0] === name);
  }
}

const TRACK = "audio/music/StereoMadness.mp3";
const RIGHT: PlayerInput = { jump: false, left: false, right: true };

interface Rig {
  sim: Sim;
  la: LevelAudio;
  music: MusicRec;
  sfx: SfxRec;
  /** Where the placed objects start in level.objects. */
  first: number;
}

/** A kit level from x 15, with LevelAudio on it and one attempt started. */
function rig(placed: Placed[], header: Partial<LevelHeader> = {}, opts: { levelId?: number; lengths?: Record<string, number>; groups?: Record<number, number[]> } = {}): Rig {
  const level = emptyLevel(placed, makeHeader(header));
  const first = level.objects.length - placed.length;
  for (const [i, g] of Object.entries(opts.groups ?? {})) level.objects[first + Number(i)].groups = g;
  const sim = header.platformer ? makeSim(level, undefined, { start: { x: 15, y: 45 } }) : simOn(level);
  const music = new MusicRec();
  const sfx = new SfxRec(opts.lengths);
  const la = new LevelAudio(level, opts.levelId ?? 1, TRACK, music, sfx);
  la.startAttempt(sim, false);
  return { sim, la, music, sfx, first };
}

function steps(r: Rig, n: number, input: PlayerInput = NO_INPUT): void {
  for (let i = 0; i < n; i++) {
    r.sim.step(input);
    r.la.update(r.sim, [0, 0]);
  }
}

/** Only the fields a test names. */
function pick<T extends object>(o: T, keys: readonly (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.map((k) => [k, o[k]])) as Partial<T>;
}

// --- the level's track (#15, #17, #18) ---------------------------------------

test("the level's track fades in over two seconds on a fresh attempt with kA15", () => {
  // [gdp PlayLayer::startMusic :105406-105410 → fadeInMusic(2.0, 0)]
  const faded = rig([], { fadeIn: true });
  assert.deepEqual(faded.music.starts(0).map((p) => pick(p, ["path", "positionMs", "fadeInMs", "loop"])), [
    { path: TRACK, positionMs: 0, fadeInMs: 2000, loop: false },
  ]);
  const plain = rig([]);
  assert.equal(plain.music.starts(0)[0].fadeInMs, 0);
});

test("a platformer's track loops until the finish", () => {
  // [gdp PlayLayer::prepareMusic → loadMusic(…, +10734) :93605; loadMusic :71356-71360]
  const r = rig([], { platformer: true });
  assert.equal(r.music.starts(0)[0].loop, true);
});

test("a finish ends the loop and leaves the song playing", () => {
  // [gdp PlayLayer::showCompleteEffect :88965-88968]
  const r = rig([]);
  r.music.calls.length = 0;
  r.la.finish(r.sim, false);
  assert.deepEqual(r.music.calls, [["endLoop", 0]]);
});

test("The Challenge and kA16 fade over two seconds", () => {
  // [gdp PlayLayer::showCompleteEffect :88969-88974]
  const challenge = rig([], {}, { levelId: 3001 });
  challenge.music.calls.length = 0;
  challenge.la.finish(challenge.sim, false);
  assert.deepEqual(challenge.music.calls, [["endLoop", 0], ["fadeOut", 0, 2]]);
  const kA16 = rig([], { fadeOut: true });
  kA16.music.calls.length = 0;
  kA16.la.finish(kA16.sim, false);
  assert.deepEqual(kA16.music.calls, [["endLoop", 0], ["fadeOut", 0, 2]]);
});

test("practice leaves the music alone at the finish", () => {
  // [gdp PlayLayer::levelComplete :92891-92898]
  const r = rig([]);
  r.la.enterPractice();
  r.music.calls.length = 0;
  r.la.finish(r.sim, true);
  assert.deepEqual(r.music.calls, []);
});

test("time warp leaves the music alone", () => {
  // [gdp updateTimeWarp :415280-415298, applyTimeWarp :416307-416320: the
  //  scheduler's time scale only]
  const r = rig([{ id: 1935, x: 300, y: 300, props: { 120: "0.2" } }]);
  steps(r, 480);
  assert.equal(r.sim.triggers.timeWarp, 0.2);
  assert.deepEqual(r.music.named("speed"), []);
  assert.ok(r.music.starts().every((p) => p.rate === 1));
});

// --- a death (#22) -------------------------------------------------------------

test("a death pauses the music and stops the sounds unless key 575 keeps them", () => {
  // Paused, not stopped: the songs stay decoded for the respawn. The death's
  // own sound comes after the stop. [gdp PlayLayer::destroyPlayer :93283-93297
  //  (pauseAllMusic :93285-93289, stopAllEffects :93291)]
  const r = rig([]);
  r.music.calls.length = 0;
  r.sfx.calls.length = 0;
  r.la.playerDied(r.sim, false);
  assert.deepEqual(r.music.calls, [["pauseAll"]]);
  assert.deepEqual(r.sfx.calls, [["stopAll"]]);

  const practice = rig([]);
  practice.la.startAttempt(practice.sim, true);
  practice.music.calls.length = 0;
  practice.sfx.calls.length = 0;
  practice.la.playerDied(practice.sim, true);
  assert.deepEqual(practice.music.calls, []);
  assert.deepEqual(practice.sfx.calls, [["stopAll"]]);

  const kept = rig([{ id: 2899, x: 100, y: 300, props: { 575: "1" } }]);
  steps(kept, 120);
  kept.music.calls.length = 0;
  kept.sfx.calls.length = 0;
  kept.la.playerDied(kept.sim, false);
  assert.deepEqual(kept.music.calls, []);
  assert.deepEqual(kept.sfx.calls, []);
});

test("a death hears what the frame fired before it, then stops it", () => {
  // A frame's steps all run before its audio. An SFX trigger fired on an
  // earlier step of the frame the player dies in had started in the game
  // before the death stopped it. [gdp activateSFXTrigger → playSFXTrigger
  //  :108930-109007, a step before destroyPlayer :93283-93297]
  const r = rig([
    { id: 3602, x: 100, y: 300, props: { 392: "5", 406: "1", 413: "1" } },
    { id: 8, x: 200, y: 45 },
  ]);
  r.sfx.calls.length = 0;
  for (let i = 0; i < 600 && !r.sim.state.dead; i++) r.sim.step(NO_INPUT);
  assert.ok(r.sim.state.dead);
  r.la.playerDied(r.sim, false);
  assert.deepEqual(r.sfx.calls.map((c) => c[0]), ["effect", "play", "stopAll"]);
  assert.deepEqual(r.sfx.calls[0], ["effect", "explode_11", 0.65]);
  r.la.update(r.sim);
  assert.equal(r.sfx.calls.length, 3, "nothing is left for the frame's own drain");
});

test("a new attempt and a respawn cut the last one's death and finish sounds; a death does not", () => {
  // [gdp PlayLayer::resetLevel :105772-105778 → stopAllEffects;
  //  EndLevelLayer::onReplay :367255-367285 → clearAllAudio; destroyPlayer
  //  stops them before its own sound :93291-93297]
  const r = rig([]);
  steps(r, 60);
  const checkpoint = r.sim.snapshot();
  r.sfx.calls.length = 0;
  r.la.playerDied(r.sim, false);
  assert.deepEqual(r.sfx.named("stopEffects"), []);
  r.la.respawn(r.sim, false, r.sim.respawnFrom(checkpoint));
  assert.deepEqual(r.sfx.named("stopEffects"), [["stopEffects"]]);
  r.la.startAttempt(simOn(emptyLevel([])), false);
  assert.deepEqual(r.sfx.named("stopEffects"), [["stopEffects"], ["stopEffects"]]);
});

// --- practice (#16) ---------------------------------------------------------------

const PRACTICE = "audio/music/StayInsideMe.mp3";

function practiceLevel(): Rig {
  return rig([
    { id: 1934, x: 300, y: 300, props: { 392: "10002867", 406: "1" } },
    { id: 3602, x: 400, y: 300, props: { 392: "5", 406: "1" } },
    { id: 3605, x: 500, y: 300, props: { 418: "1", 406: "0.5" } },
    { id: 3603, x: 500, y: 300, props: { 455: "3", 418: "1", 406: "0.5" } },
  ]);
}

test("practice plays Stay Inside Me and nothing the level asks for", () => {
  // From its start whenever it is ready, not kept to the music clock.
  // [gdp PlayLayer::togglePracticeMode :107466-107480 → playMusic :71410-71432
  //  → loadMusic at 0 :71427; the audio triggers return at once without sync
  //  :446513, :447113, :447166, :447266]
  const r = practiceLevel();
  r.la.enterPractice();
  assert.deepEqual(pick(r.music.starts(0).at(-1) as ChannelPlay, ["path", "loop", "positionMs", "synced"]), { path: PRACTICE, loop: true, positionMs: 0, synced: false });
  assert.equal(r.music.starts(0)[0].synced, true, "the level's track keeps to the music clock");
  const before = r.music.calls.length;
  r.sfx.calls.length = 0;
  steps(r, 480);
  assert.deepEqual(r.music.calls.slice(before), []);
  assert.deepEqual(r.sfx.plays(), []);
  assert.deepEqual(r.sfx.named("volume"), []);
});

test("a death and a respawn in practice leave the practice track running", () => {
  // [gdp destroyPlayer :93285-93288; resetLevel :105775-105777;
  //  loadFromCheckpoint :105531; startMusic's fade :105406-105410]
  const r = practiceLevel();
  r.la.enterPractice();
  steps(r, 240);
  const checkpoint = r.sim.snapshot();
  steps(r, 60);
  r.music.calls.length = 0;
  r.sfx.calls.length = 0;
  r.la.playerDied(r.sim, true);
  r.la.respawn(r.sim, true, r.sim.respawnFrom(checkpoint));
  assert.deepEqual(r.music.calls, []);
  // The reset puts the reverb back to preset 0 in practice too.
  // [resetLevel :105781 → resetLevelVariables :462921]
  assert.deepEqual(r.sfx.calls, [["stopAll"], ["stopAll"], ["stopEffects"], ["reverbPreset", 0]]);

  // A restart in practice keeps the track, and kA15's fade runs on it.
  const fading = rig([], { fadeIn: true });
  fading.la.enterPractice();
  fading.music.calls.length = 0;
  fading.la.startAttempt(simOn(emptyLevel([], makeHeader({ fadeIn: true }))), true);
  assert.deepEqual(fading.music.calls, [["fadeIn", 0, 2]]);
});

test("entering practice leaves the level's sounds playing, and their proximity running", () => {
  // Only the music changes; the sounds stop at the next death or reset.
  // [gdp togglePracticeMode :107466-107480 (stopAllMusic, no stopAllEffects);
  //  PauseLayer::onPracticeMode :235339-235350; GJBaseGameLayer::update :470071
  //  → updateProximityVolumeEffects, with no practice check]
  const keys = { 392: "5", 406: "1", 413: "1", 51: "9", 138: "1", 421: "1", 422: "0.5", 423: "0", 425: "175", 426: "175", 458: "3" };
  const r = rig([{ id: 3602, x: 300, y: 300, props: keys }, { id: 1, x: 600, y: 900 }], {}, { groups: { 1: [9] } });
  steps(r, 240);
  const [[voice]] = r.sfx.plays();
  r.sfx.calls.length = 0;
  r.la.enterPractice();
  assert.deepEqual(r.sfx.calls, []);
  steps(r, 600);
  const mods = r.sfx.named("volumeMod").filter((c) => c[1] === voice);
  assert.ok(mods.length > 1, "the voice's proximity still follows player 1");
  assert.ok((mods.at(-1)?.[2] as number) < 1);
  assert.deepEqual(r.sfx.named("stopAll"), []);
  assert.deepEqual(r.sfx.plays(), [], "and practice starts nothing");
});

test("leaving practice starts the level's track", () => {
  // [gdp togglePracticeMode :107482-107485 → resetLevelFromStart]
  const r = practiceLevel();
  r.la.enterPractice();
  r.music.calls.length = 0;
  r.la.startAttempt(simOn(emptyLevel([])), false);
  assert.deepEqual(r.music.starts(0).map((p) => pick(p, ["path", "positionMs"])), [{ path: TRACK, positionMs: 0 }]);
});

// --- Song and Edit Song (#14, #19) -------------------------------------------------

test("an Edit Song edits its channel and starts nothing", () => {
  // [gdp activateSongEditTrigger :447107-447128 → applySFXEditTrigger :431769-431804]
  const r = rig([{ id: 3605, x: 300, y: 300, props: { 406: "0.4", 418: "1", 10: "1" } }]);
  r.music.calls.length = 0;
  steps(r, 300);
  assert.deepEqual(r.music.calls, [["volume", 0, 0.4000000059604645, 1]]);
});

test("a Song trigger on channel 1 plays alongside the track", () => {
  // [gdp triggerQueuedMusic :71645-71701 stops only its own channel]
  const r = rig([{ id: 1934, x: 300, y: 300, props: { 392: "10002867", 432: "1", 406: "1", 413: "1" } }]);
  r.music.calls.length = 0;
  steps(r, 300);
  assert.deepEqual(r.music.calls.map((c) => c[0]), ["start"]);
  assert.deepEqual(pick(r.music.starts(1)[0], ["path", "positionMs", "loop", "volume", "rate"]), {
    path: "audio/songs/10002867.ogg",
    positionMs: 0,
    loop: true,
    volume: 1,
    rate: 1,
  });
});

const SETTINGS = ["positionMs", "rate", "volume", "loop", "loopStartMs", "loopEndMs", "fadeInMs", "endMs", "fadeOutMs"] as const;

test("a Song trigger's settings", () => {
  // [gdp activateSongTrigger :446535-446554 → queueStartMusic; FMODAudioEngine::startMusic :70651-70800]
  const looped = rig([{ id: 1934, x: 300, y: 300, props: { 392: "10006555", 406: "0.6", 404: "-2", 408: "15000", 409: "1000", 410: "22500", 413: "1" } }]);
  steps(looped, 300);
  assert.deepEqual(pick(looped.music.starts(0).at(-1) as ChannelPlay, SETTINGS), {
    positionMs: 15000, rate: 0.8908987045288086, volume: 0.6000000238418579, loop: true,
    loopStartMs: 15000, loopEndMs: 22500, fadeInMs: 1000, endMs: 0, fadeOutMs: 0,
  });
  const once = rig([{ id: 1934, x: 300, y: 300, props: { 392: "10006555", 406: "0.6", 404: "-2", 408: "15000", 409: "1000", 410: "22500", 411: "500" } }]);
  steps(once, 300);
  assert.deepEqual(pick(once.music.starts(0).at(-1) as ChannelPlay, SETTINGS), {
    positionMs: 15000, rate: 0.8908987045288086, volume: 0.6000000238418579, loop: false,
    loopStartMs: 0, loopEndMs: 0, fadeInMs: 1000, endMs: 22500, fadeOutMs: 500,
  });
});

test("a prepared song waits for its load trigger, which plays it with the prep's settings", () => {
  // [gdp activateSongTrigger :446528-446532 → activateQueuedMusic :72528-72560;
  //  activatedAudioTrigger :447822-447830]
  const r = rig([
    { id: 1934, x: 300, y: 300, props: { 392: "10006555", 399: "1", 408: "15000", 410: "22500", 413: "1", 406: "0.6" } },
    { id: 1934, x: 600, y: 300, props: { 400: "1", 406: "1", 408: "999" } },
  ]);
  r.music.calls.length = 0;
  steps(r, 300);
  assert.deepEqual(r.music.calls, [["prepare", "audio/songs/10006555.ogg"]]);
  steps(r, 300);
  assert.deepEqual(r.music.starts(0).map((p) => pick(p, ["path", "positionMs", "volume", "loopStartMs"])), [
    { path: "audio/songs/10006555.ogg", positionMs: 15000, volume: 0.6000000238418579, loopStartMs: 15000 },
  ]);
});

test("a respawn picks the song up where the checkpoint is, and the sounds that had finished stay finished", () => {
  // The Song trigger at x 300 fires at tick 220; the checkpoint is laid 2 s in.
  // The music clock goes back with the checkpoint, and the song picks up where
  // it was then. [gdp loadFromCheckpoint :105531-105544 →
  //  processActivatedAudioTriggers → processSongState]
  const r = rig(
    [
      { id: 3602, x: 100, y: 300, props: { 392: "5", 406: "1" } },
      { id: 1934, x: 300, y: 300, props: { 392: "6", 406: "1" } },
    ],
    {},
    { lengths: { s5: 200 } },
  );
  steps(r, 480);
  const song = r.sim.triggers.events.find((e) => e.kind === "song");
  assert.equal(song?.at, 0.9166666666666646);
  const checkpoint = r.sim.snapshot();
  assert.equal(r.sim.triggers.musicTime, 1.9999999999999942);
  steps(r, 600);
  r.music.calls.length = 0;
  r.sfx.calls.length = 0;
  r.la.respawn(r.sim, false, r.sim.respawnFrom(checkpoint));
  assert.deepEqual(r.music.starts().map((p) => pick(p, ["path", "positionMs"])), [{ path: "audio/songs/6.mp3", positionMs: 1083 }]);
  assert.deepEqual(r.sfx.plays(), [], "the effect had finished before the checkpoint");
  assert.deepEqual(r.music.named("busFadeIn"), [], "only a platformer fades the music back in");
  // After the respawn only what comes next plays.
  steps(r, 10);
  assert.deepEqual(r.sfx.plays(), []);
});

test("not after a checkpoint; a platformer's music fades back in over 0.1 s", () => {
  // [gdp loadFromCheckpoint :105537-105540 → fadeInBackgroundMusic(0.1)]
  const r = rig([], { platformer: true, fadeIn: true });
  steps(r, 480);
  const checkpoint = r.sim.snapshot();
  steps(r, 600);
  r.music.calls.length = 0;
  r.la.respawn(r.sim, false, r.sim.respawnFrom(checkpoint));
  assert.deepEqual(r.music.named("busFadeIn"), [["busFadeIn", 0.1]]);
  assert.deepEqual(r.music.named("fadeIn"), []);
  assert.deepEqual(r.music.starts(0).map((p) => pick(p, ["path", "positionMs", "fadeInMs", "loop"])), [
    { path: TRACK, positionMs: levelSongPositionMs(0, 1.9999999999999942), fadeInMs: 0, loop: true },
  ]);
  assert.equal(levelSongPositionMs(0, 1.9999999999999942), 2000);
});

test("a stopped channel stays stopped on a respawn", () => {
  // An Edit Song with 417 clears its channel's song. [activatedAudioTrigger
  //  :447941-447951; processActivatedAudioTriggers → stopMusicNotInSet :454966]
  const r = rig([
    { id: 1934, x: 300, y: 300, props: { 392: "10002867", 432: "1", 406: "1", 413: "1" } },
    { id: 3605, x: 600, y: 300, props: { 432: "1", 417: "1" } },
  ]);
  steps(r, 480);
  assert.deepEqual(r.music.named("stop"), [["stop", 1]]);
  const checkpoint = r.sim.snapshot();
  steps(r, 60);
  r.music.calls.length = 0;
  r.la.respawn(r.sim, false, r.sim.respawnFrom(checkpoint));
  assert.deepEqual(r.music.starts(1), []);
  assert.equal(r.music.starts(0).length, 1, "the level's track is back on channel 0");
});

test("the warm-up's songs are kept and the last one plays where it would be", () => {
  // [gdp PlayLayer::startMusic :105411-105415 → processActivatedAudioTriggers
  //  :454746-454962]
  const level = emptyLevel([
    { id: 1934, x: 100, y: 300, props: { 392: "6", 406: "1" } },
    { id: 1934, x: 200, y: 300, props: { 392: "7", 406: "1" } },
    { id: 2900, x: 300, y: 300, props: { 13: "1", 166: "2", 167: "4", 171: "1", 172: "1", 173: "1" } },
    { id: 3602, x: 400, y: 300, props: { 392: "5" } },
    { id: 31, x: 900, y: 45, settings: {} },
  ], makeHeader({ fadeIn: true }));
  const sim = makeSim(level);
  assert.deepEqual(sim.triggers.events.map((e) => [e.kind, e.id]), [["song", 6], ["song", 7]]);
  const music = new MusicRec();
  const la = new LevelAudio(level, 1, TRACK, music, new SfxRec());
  la.startAttempt(sim, false);
  assert.deepEqual(music.starts().map((p) => pick(p, ["path", "positionMs", "fadeInMs"])), [{ path: "audio/songs/7.mp3", positionMs: 2238, fadeInMs: 0 }]);
  assert.deepEqual(music.named("fadeIn"), []);
});

// --- SFX and Edit SFX (#20) ---------------------------------------------------------

test("an SFX trigger's settings", () => {
  // [gdp GameManager::playSFXTrigger :108930-109007 → playEffectAdvanced :73942-74280]
  const r = rig([{ id: 3602, x: 300, y: 300, props: { 392: "5", 404: "-2", 405: "2", 406: "3", 408: "100", 409: "50", 410: "600", 411: "100" } }]);
  steps(r, 300);
  const [[, v]] = r.sfx.plays();
  assert.deepEqual(pick(v, ["name", "rate", "pitch", "volume", "offsetMs", "fadeInMs", "endMs", "fadeOutMs", "loop"]), {
    name: "s5", rate: 0.8908987045288086, pitch: 1.122562050819397, volume: 2, offsetMs: 100, fadeInMs: 50, endMs: 600, fadeOutMs: 100, loop: false,
  });
});

test("no volume is silence", () => {
  // [gdp SFXTriggerGameObject::customObjectSetup :309589-309596]
  const r = rig([{ id: 3602, x: 300, y: 300, props: { 392: "5" } }]);
  steps(r, 300);
  assert.equal(r.sfx.plays()[0][1].volume, 0);
});

test("an Edit SFX plays nothing and asks for no file", () => {
  const r = rig([{ id: 3603, x: 300, y: 300, props: { 418: "1", 406: "0.5" } }]);
  steps(r, 300);
  assert.deepEqual(r.sfx.plays(), []);
  assert.ok(!JSON.stringify(r.sfx.calls).includes("s0"));
});

test("a unique sound plays once, unless the next one overrides it", () => {
  // [gdp playEffectAdvanced :74067-74082]
  const same = { 392: "5", 413: "1", 415: "1", 416: "7", 406: "1" };
  const kept = rig([{ id: 3602, x: 300, y: 300, props: same }, { id: 3602, x: 400, y: 300, props: same }]);
  steps(kept, 400);
  assert.equal(kept.sfx.plays().length, 1);
  const cut = rig([{ id: 3602, x: 300, y: 300, props: same }, { id: 3602, x: 400, y: 300, props: { ...same, 420: "1" } }]);
  steps(cut, 400);
  const plays = cut.sfx.plays();
  assert.equal(plays.length, 2);
  assert.deepEqual(cut.sfx.named("stop"), [["stop", plays[0][0], false]]);
});

test("the minimum interval keeps the same SFX from playing again too soon", () => {
  // [gdp playEffectAdvanced :74266-74277, key 434 as a19 from playSFXTrigger :109003]
  const r = rig([{ id: 3602, x: 3000, y: 300, props: { 392: "5", 434: "1", 406: "1" } }]);
  const object = r.first;
  for (const [tick, at] of [[1, 1.0], [2, 1.5], [3, 2.1]] as const) r.la.trigger({ tick, kind: "sfx", id: 5, object, at }, r.sim, tick);
  assert.equal(r.sfx.plays().length, 2);
});

test("an SFX that two Spawn triggers spawn in one tick plays twice, and a unique one once", () => {
  // Each spawn activates it, and nothing between the trigger and the sound
  // checks the frame. [gdp spawnGroup :443163-443230, keyed by spawner with
  //  kA40; activateSFXTrigger :447147-447225 → playSFXTrigger
  //  :108930-109007 → playEffectAdvanced :73942-74280]
  const spawned = (sfx: Record<number, string>): Rig =>
    rig(
      [
        { id: 1268, x: 200, y: 300, props: { 51: "5" } },
        { id: 1268, x: 200, y: 330, props: { 51: "5" } },
        { id: 3602, x: 1000, y: 300, props: { 392: "5", 406: "1", 62: "1", 87: "1", ...sfx } },
      ],
      { enable22Changes: true },
      { groups: { 2: [5] } },
    );
  const twice = spawned({});
  steps(twice, 200);
  const plays = twice.sfx.plays();
  assert.equal(plays.length, 2);
  assert.notEqual(plays[0][0], plays[1][0]);
  const unique = spawned({ 413: "1", 415: "1", 416: "7" });
  steps(unique, 200);
  assert.equal(unique.sfx.plays().length, 1);
});

test("an Edit SFX reaches a unique sound, an SFX group, and the sounds of a group of triggers", () => {
  // [gdp GJBaseGameLayer::activateSFXEditTrigger :447241-447359]
  const r = rig(
    [
      { id: 3602, x: 200, y: 300, props: { 392: "5", 413: "1", 415: "1", 416: "7", 406: "1" } },
      { id: 3603, x: 300, y: 300, props: { 416: "7", 418: "1", 406: "0.75", 10: "0.99" } },
      { id: 3603, x: 400, y: 300, props: { 455: "3", 418: "1", 406: "0.5" } },
      { id: 3602, x: 500, y: 300, props: { 392: "6", 455: "3", 406: "1" } },
      { id: 3602, x: 600, y: 300, props: { 392: "8", 413: "1", 406: "1" } },
      { id: 3602, x: 610, y: 300, props: { 392: "9", 413: "1", 406: "1" } },
      { id: 3603, x: 700, y: 300, props: { 457: "840", 417: "1" } },
    ],
    {},
    { groups: { 4: [840], 5: [840] } },
  );
  steps(r, 900);
  const plays = r.sfx.plays();
  const voiceOf = (name: string): number => (plays.find(([, v]) => v.name === name) as [number, VoicePlay])[0];
  assert.deepEqual(r.sfx.named("volume"), [["volume", voiceOf("s5"), 0.75, 0.9900000095367432]]);
  assert.deepEqual(r.sfx.named("groupVolume"), [["groupVolume", 3, 0.5, 0]]);
  assert.equal(plays.find(([, v]) => v.name === "s6")?.[1].group, 3);
  assert.deepEqual(r.sfx.named("stop"), [["stop", voiceOf("s8"), false], ["stop", voiceOf("s9"), false]]);
});

test("a respawn plays on the sounds still sounding at the checkpoint, from where they were", () => {
  // The engine saves what is playing with the checkpoint and starts it again
  // where it was. [gdp FMODAudioEngine::saveAudioState :68887-68928,
  //  loadAudioState :74331-74397; PlayLayer::loadFromCheckpoint :105535]
  const r = rig(
    [
      { id: 3602, x: 300, y: 300, props: { 392: "5", 490: "0.5", 406: "1" } },
      { id: 3602, x: 300, y: 300, props: { 392: "6", 413: "1", 404: "-2", 406: "1" } },
    ],
    {},
    { lengths: { s5: 500, s6: 3000 } },
  );
  steps(r, 480);
  const checkpoint = r.sim.snapshot();
  steps(r, 60);
  r.sfx.calls.length = 0;
  r.la.respawn(r.sim, false, r.sim.respawnFrom(checkpoint));
  const plays = r.sfx.plays();
  assert.deepEqual(plays.map(([, v]) => v.name), ["s6"]);
  // (2 − 0.9167) s at 0.8909: the game's float steps give 965.
  const offset = plays[0][1].offsetMs;
  assert.ok(Math.abs(offset - 965) < 1, `offset ${offset}`);
  assert.equal(plays[0][1].rate, pitchForIdx(-2));
});

test("key 407 sends a sound through the reverb, and key 503 switches it to key 502's preset", () => {
  // The preset changes before the sound plays, and a new attempt puts it back
  // to 0. [gdp SFXTriggerGameObject::customObjectSetup :309597-309600,
  //  :309751-309758; activateSFXTrigger :447202-447206; playSFXTrigger :108974;
  //  resetLevelVariables :462921]
  const r = rig([
    { id: 3602, x: 300, y: 300, props: { 392: "5", 406: "1", 407: "1" } },
    { id: 3602, x: 600, y: 300, props: { 392: "6", 406: "1", 502: "8", 503: "1" } },
    { id: 3602, x: 900, y: 300, props: { 392: "7", 406: "1", 502: "3" } },
  ]);
  assert.deepEqual(r.sfx.calls.slice(0, 3), [["stopAll"], ["stopEffects"], ["reverbPreset", 0]], "an attempt starts on preset 0");
  steps(r, 900);
  assert.deepEqual(r.sfx.plays().map(([, v]) => [v.name, v.reverb]), [["s5", true], ["s6", false], ["s7", false]]);
  const order = r.sfx.calls.filter((c) => c[0] === "reverbPreset" || c[0] === "play").map((c) => (c[0] === "play" ? (c[2] as VoicePlay).name : c[1]));
  assert.deepEqual(order, [0, "s5", 8, "s6", "s7"], "503 switches before its own sound; 502 alone does nothing");
});

test("proximity silence keeps an SFX trigger from switching the reverb; a refused sound does not", () => {
  // The switch comes after the proximity check and before the minimum
  // interval and the unique test, which are the engine's.
  // [gdp activateSFXTrigger :447183-447206 → playSFXTrigger → playEffectAdvanced
  //  :74067-74082, :74266-74277]
  const r = rig([
    { id: 3602, x: 300, y: 300, props: { 392: "5", 406: "1", 502: "4", 503: "1", 51: "9", 421: "0", 422: "0", 423: "0", 424: "1", 138: "1" } },
    { id: 1, x: 3000, y: 900 },
    { id: 3602, x: 600, y: 300, props: { 392: "6", 406: "1", 415: "1", 416: "7", 413: "1" } },
    { id: 3602, x: 700, y: 300, props: { 392: "6", 406: "1", 415: "1", 416: "7", 502: "9", 503: "1" } },
  ], {}, { groups: { 1: [9] }, lengths: { s6: 5000 } });
  steps(r, 900);
  assert.deepEqual(r.sfx.plays().map(([, v]) => v.name), ["s6"], "silenced, then one unique sound");
  assert.deepEqual(r.sfx.named("reverbPreset").slice(1), [["reverbPreset", 9]], "only the refused unique one switches");
});

test("a respawn puts the reverb back to preset 0, and the sounds it restores keep key 407", () => {
  // The checkpoint keeps each sound's flag but not the preset, which the
  // reset has already put back. [gdp resetLevel :105781 → resetLevelVariables
  //  :462921; loadFromCheckpoint :105531-105544 → loadAudioState :74338, :74346]
  const r = rig(
    [{ id: 3602, x: 300, y: 300, props: { 392: "6", 406: "1", 407: "1", 413: "1", 502: "12", 503: "1" } }],
    {},
    { lengths: { s6: 3000 } },
  );
  steps(r, 480);
  const checkpoint = r.sim.snapshot();
  steps(r, 60);
  r.sfx.calls.length = 0;
  r.la.respawn(r.sim, false, r.sim.respawnFrom(checkpoint));
  assert.deepEqual(r.sfx.named("reverbPreset"), [["reverbPreset", 0]]);
  assert.deepEqual(r.sfx.plays().map(([, v]) => [v.name, v.reverb]), [["s6", true]]);
});

test("a start position's replay switches the reverb for each sound it plays again", () => {
  // The replay fires the trigger of each sound still sounding once the
  // warm-up is over; one that has finished is not fired again.
  // [gdp processActivatedAudioTriggers :455163-455196 → activateSFXTrigger
  //  :447202-447206]
  const level = emptyLevel([
    { id: 3602, x: 300, y: 300, props: { 392: "5", 406: "1", 490: "0.1", 502: "2", 503: "1" } },
    { id: 3602, x: 400, y: 300, props: { 392: "6", 406: "1", 413: "1", 490: "3", 502: "15", 503: "1" } },
    { id: 31, x: 900, y: 45, settings: {} },
  ]);
  const sim = makeSim(level);
  const sfx = new SfxRec();
  const la = new LevelAudio(level, 1, TRACK, new MusicRec(), sfx);
  la.startAttempt(sim, false);
  assert.deepEqual(sfx.named("reverbPreset"), [["reverbPreset", 0], ["reverbPreset", 15]]);
  assert.deepEqual(sfx.plays().map(([, v]) => v.name), ["s6"]);
});

test("the reverb presets are FMOD's, and anything outside 1-22 is Generic", () => {
  // [gdp FMODAudioEngine::updateReverb :64026-64049; reverbToString :64173-64253]
  assert.equal(reverbPreset(0), GENERIC_REVERB);
  assert.equal(reverbPreset(23), GENERIC_REVERB);
  assert.equal(reverbPreset(-1), GENERIC_REVERB);
  assert.deepEqual(GENERIC_REVERB, { decay: 1500, earlyDelay: 7, lateDelay: 11, hfDecay: 83, diffusion: 100, density: 100, highCut: 14500, earlyLateMix: 96, wet: -8 });
  assert.equal(reverbPreset(1).decay, 170, "1 is the padded cell");
  assert.equal(reverbPreset(10).decay, 10000, "10 the hangar");
  assert.equal(reverbPreset(22).wet, 7, "22 underwater");
  // The impulse: silent until the early delay, as long as the decay, and
  // as loud as the wet level says.
  const [left, right] = reverbImpulse(GENERIC_REVERB, 48000);
  assert.equal(left.length, Math.ceil((0.018 + 1.5) * 48000));
  assert.equal(right.length, left.length);
  assert.equal(left.slice(0, Math.floor(0.007 * 48000) - 1).every((v) => v === 0), true);
  const energy = left.reduce((a, v) => a + v * v, 0);
  assert.ok(Math.abs(Math.sqrt(energy) - Math.pow(10, -8 / 20)) < 1e-4, `energy ${energy}`);
  assert.deepEqual(reverbImpulse(GENERIC_REVERB, 48000)[0], left, "the same every time");
});

/** Walks right until the platformer checkpoint is laid, with the audio each step. */
function walkToCheckpoint(r: Rig): SimSnapshot {
  for (let i = 0; i < 240; i++) {
    steps(r, 1, RIGHT);
    const laid = r.sim.takePlatformerCheckpoint();
    if (laid) return laid;
  }
  throw new Error("no checkpoint laid");
}

test("what a checkpoint's key 51 plays is not part of it, so a respawn does not play it again", () => {
  // The game saves the audio with the checkpoint and only then spawns key 51,
  // in the same step. [gdp PlayLayer::postUpdate: markCheckpoint :105316
  //  (createCheckpoint → saveAudioState :105120), then key 51 :105352-105359]
  const r = rig(
    [
      { id: 2063, x: 120, y: 60, props: { 11: "1", 51: "6" } },
      { id: 3602, x: 0, y: 900, props: { 62: "1", 392: "5", 406: "0.9" } },
    ],
    { platformer: true },
    { lengths: { s5: 5000 }, groups: { 1: [6] } },
  );
  const laid = walkToCheckpoint(r);
  assert.deepEqual(r.sfx.plays().map(([, v]) => v.name), ["s5"], "heard once, as it is spawned");
  steps(r, 30, RIGHT);
  for (let n = 0; n < 2; n++) {
    r.sfx.calls.length = 0;
    r.la.respawn(r.sim, false, r.sim.respawnFrom(laid));
    steps(r, 10);
    assert.deepEqual(r.sfx.plays(), [], `respawn ${n + 1}`);
  }
});

test("what key 448 plays on a respawn is heard, once each time", () => {
  // It spawns after the checkpoint's audio is back, in the checkpoint's tick.
  // [gdp PlayLayer::resetLevel :105965-105973, after loadFromCheckpoint
  //  :105531-105544]
  const r = rig(
    [
      { id: 2063, x: 120, y: 60, props: { 11: "1", 448: "6" } },
      { id: 3602, x: 0, y: 900, props: { 62: "1", 392: "5", 406: "0.9" } },
    ],
    { platformer: true },
    { lengths: { s5: 5000 }, groups: { 1: [6] } },
  );
  const laid = walkToCheckpoint(r);
  assert.deepEqual(r.sfx.plays(), []);
  steps(r, 30, RIGHT);
  for (let n = 0; n < 2; n++) {
    r.sfx.calls.length = 0;
    const kept = r.sim.respawnFrom(laid);
    assert.equal(r.sim.triggers.events.length, kept + 1);
    assert.equal(r.sim.triggers.events[kept].tick, laid.tick);
    r.la.respawn(r.sim, false, kept);
    assert.deepEqual(r.sfx.plays(), [], `respawn ${n + 1}: not part of the checkpoint`);
    steps(r, 1);
    assert.deepEqual(r.sfx.plays().map(([, v]) => v.name), ["s5"], `respawn ${n + 1}: heard live`);
    steps(r, 10);
  }
});

// --- proximity (#14, #20) ------------------------------------------------------------

test("an Edit Song's proximity follows player 1", () => {
  // 5001 #5758's keys: channel 0 goes from 1 to 0 as player 1 walks 1050
  // units right of the group. [gdp addProximityVolumeEffect :447022-447092;
  //  updateProximityVolumeEffects :432247-432275]
  const keys = { 51: "9", 138: "1", 421: "1", 422: "0.5", 423: "0", 425: "175", 426: "175", 458: "3", 10: "0.5" };
  const r = rig([{ id: 3605, x: 300, y: 300, props: keys }, { id: 1, x: 600, y: 900 }], {}, { groups: { 1: [9] } });
  const params = audioParams(r.sim.level.objects[r.first]);
  let reached = -1;
  for (let i = 0; i < 1400; i++) {
    steps(r, 1);
    const mods = r.music.named("volumeMod");
    if (mods.length === 0) continue;
    const trig = r.sim.triggers;
    const want = proximityFor(params, {
      player1: [r.sim.state.x, r.sim.state.y],
      player2: null,
      camera: [0, 0],
      members: (g) => trig.groupMembers(g),
      position: (idx) => trig.objectPosition(idx),
      disabled: (idx) => trig.objectDisabled(idx),
      mainObject: (g) => trig.mainObjectOf(g),
    });
    assert.deepEqual(mods.at(-1), ["volumeMod", 0, want], `tick ${r.sim.tick}`);
    if (want === 0 && reached < 0) reached = r.sim.state.x;
  }
  assert.ok(reached >= 1650 && reached < 1660, `silent from x ${reached}`);
});
