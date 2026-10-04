import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOST_CONFIG, parseHostConfig, ROBTOP_DIRECT, serverBase } from "../src/online/hostConfig";
import { audioUrl, formFor, parseGauntlets, parseLevelPage, parseMapPacks, parseSong } from "../src/online/robtop";

test("each server mode sends requests to its own base", () => {
  const origin = "https://games.example";
  assert.equal(serverBase(parseHostConfig({ server: { mode: "direct" } }), origin), ROBTOP_DIRECT);
  assert.equal(
    serverBase(parseHostConfig({ server: { mode: "hostApi", hostApi: "https://relay.example/gd/" } }), origin),
    "https://relay.example/gd",
  );
  assert.equal(serverBase(parseHostConfig({ server: { mode: "autodetect" } }), origin), "https://games.example/api/robtop-server");
});

test("a broken or partial host config falls back to autodetect with no label", () => {
  assert.deepEqual(parseHostConfig(null), DEFAULT_HOST_CONFIG);
  assert.deepEqual(parseHostConfig("nope"), DEFAULT_HOST_CONFIG);
  assert.equal(parseHostConfig({ server: { mode: "warp" } }).server.mode, "autodetect");
  // A host API mode without an address has nowhere to go.
  assert.equal(parseHostConfig({ server: { mode: "hostApi", hostApi: "" } }).server.mode, "autodetect");
  assert.equal(parseHostConfig({ hostedBy: "  Proton  " }).hostedBy, "Proton");
});

test("requests carry the 2.2 client's form", () => {
  const form = formFor({ levelID: 128 });
  assert.equal(form.get("secret"), "Wmfd2893gb7");
  assert.equal(form.get("gameVersion"), "22");
  assert.equal(form.get("levelID"), "128");
});

test("a level list reply becomes levels with authors, songs and the page", () => {
  const level = "1:128:2:1st level:3:SGVsbG8=:5:3:6:16:9:10:10:500:12:0:14:20:15:2:17:0:18:2:25:0:35:467339:37:1:38:1:42:1:45:30";
  const reply = `${level}#16:RobTop:71#1~|~467339~|~2~|~At the Speed of Light~|~4~|~Dimrain47~|~10~|~http%3A%2F%2Faudio.ngfiles.com%2F467000%2F467339_At_the_Speed_of_Light.mp3#9999:0:10`;
  const page = parseLevelPage(reply, 0);
  assert.equal(page.total, 9999);
  assert.equal(page.perPage, 10);
  const [l] = page.levels;
  assert.equal(l.id, 128);
  assert.equal(l.name, "1st level");
  assert.equal(l.description, "Hello");
  assert.equal(l.author, "RobTop");
  assert.equal(l.face, 1);
  assert.equal(l.epic, 1);
  assert.deepEqual(l.song, { kind: "custom", id: 467339, name: "At the Speed of Light", artist: "Dimrain47", available: true });
  assert.deepEqual(parseLevelPage("-1", 3), { levels: [], total: 0, page: 3, perPage: 10 });
});

test("map packs, gauntlets and song info parse", () => {
  const packs = parseMapPacks("1:1:2:Cool Pack:3:1,2,3:4:4:5:1:6:2:7:255,0,128#1:0:10");
  assert.equal(packs.packs[0].name, "Cool Pack");
  assert.deepEqual(packs.packs[0].levels, [1, 2, 3]);
  assert.equal(packs.packs[0].face, 2);
  assert.deepEqual(packs.packs[0].colour, [255, 0, 128]);
  assert.deepEqual(parseGauntlets("1:1:3:10,20,30|1:2:3:40#hash"), [
    { id: 1, levels: [10, 20, 30] },
    { id: 2, levels: [40] },
  ]);
  const song = parseSong("1~|~5~|~2~|~Song~|~4~|~Artist~|~10~|~-");
  assert.equal(song?.available, false);
});

test("sounds come from the allowed hosts only, through the tunnel unless direct", () => {
  const ng = "http://audio.ngfiles.com/467000/467339.mp3";
  assert.equal(audioUrl(ng, true, "x"), "https://audio.ngfiles.com/467000/467339.mp3");
  assert.equal(
    audioUrl(ng, false, "https://h/api/robtop-server"),
    `https://h/api/robtop-server/audio?url=${encodeURIComponent("https://audio.ngfiles.com/467000/467339.mp3")}`,
  );
  assert.equal(audioUrl("https://evil.example/a.mp3", false, "x"), null);
});
