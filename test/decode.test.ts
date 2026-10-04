import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/level/decode";
import { LEVELS_DIR as LEVELS } from "../tools/paths";
export const OFFICIAL_LEVEL_IDS = [...Array.from({ length: 22 }, (_, i) => i + 1), 3001, 5001, 5002, 5003, 5004];

test("decodes Stereo Madness", async () => {
  const lv = await loadLevel(readFileSync(`${LEVELS}/1.txt`, "latin1"));
  assert.equal(lv.header.startMode, "cube");
  assert.equal(lv.header.startSpeed, 1);
  assert.ok(lv.objects.length > 1000, `objects: ${lv.objects.length}`);
  assert.ok(lv.header.colors.get(1000), "bg colour from kS29");
  assert.equal(lv.header.colors.get(1000)!.r, 40);
});

test("decodes Dash despite the trailing NUL", async () => {
  const lv = await loadLevel(readFileSync(`${LEVELS}/22.txt`, "latin1"));
  assert.ok(lv.objects.length > 15000, `objects: ${lv.objects.length}`);
  assert.ok(lv.header.colors.get(1000));
  assert.ok(lv.objects.find((o) => o.id === 1933), "Dash has a swing portal");
});

test("an object's own colour shift is read, and only when it is switched on", async () => {
  const { parseObject } = await import("../src/level/decode");
  // 41/43 is the base shift, 42/44 the detail one. The value is "h a s a v a
  // sChecked a vChecked", and levels leave a stale value behind on plenty of
  // objects whose checkbox is off.
  const on = parseObject("1,1,2,15,3,15,41,1,43,120a0.5a1a1a0,42,1,44,-30a1a0.2a0a1", 0)!;
  assert.deepEqual(on.baseHsv, { h: 120, s: 0.5, v: 1, sChecked: true, vChecked: false });
  assert.deepEqual(on.detailHsv, { h: -30, s: 1, v: 0.2, sChecked: false, vChecked: true });

  const off = parseObject("1,1,2,15,3,15,43,120a0.5a1a1a0,44,-30a1a0.2a0a1", 0)!;
  assert.equal(off.baseHsv, null);
  assert.equal(off.detailHsv, null);

  const plain = parseObject("1,1,2,15,3,15,20,7", 0)!;
  assert.equal(plain.baseHsv, null);
  assert.equal(plain.editorLayer, 7);
});

test("the official levels carry the colour shifts the Towers depend on", async () => {
  const lv = await loadLevel(readFileSync(`${LEVELS}/5003.txt`, "latin1"));
  const shifted = lv.objects.filter((o) => o.baseHsv !== null || o.detailHsv !== null);
  assert.ok(shifted.length > 3000, `Tower floor 3 shifts ${shifted.length} objects`);
});

test("every official level decodes", async () => {
  for (const n of OFFICIAL_LEVEL_IDS) {
    const lv = await loadLevel(readFileSync(`${LEVELS}/${n}.txt`, "latin1"));
    assert.ok(lv.objects.length > 100, `level ${n}: ${lv.objects.length} objects`);
  }
});

test("kA32 and kA34 are read the way the game reads them", async () => {
  // CCString::boolValue: missing, empty, "0" and "false" are off, anything else
  // is on. [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196273-196283;
  //  CCString::boolValue :797566-797579]
  const { parseHeader } = await import("../src/level/decode");
  const both = (h: string) => {
    const p = parseHeader(h);
    return [p.fixGravityBug, p.fixRobotJump];
  };
  assert.deepEqual(both("kA32,1,kA34,1"), [true, true]);
  assert.deepEqual(both("kA32,0,kA34,0"), [false, false]);
  assert.deepEqual(both(""), [false, false]);
  assert.deepEqual(both("kA34,true"), [false, true]);
  assert.deepEqual(both("kA32,false,kA34,"), [false, false]);

  // Levels 1–21 and The Challenge carry neither key; Dash and the Tower floors
  // after the first carry both.
  const official: Array<[number, boolean]> = [
    [1, false],
    [22, true],
    [5001, false],
    [5002, true],
  ];
  for (const [id, on] of official) {
    const lv = await loadLevel(readFileSync(`${LEVELS}/${id}.txt`, "latin1"));
    assert.deepEqual([lv.header.fixGravityBug, lv.header.fixRobotJump], [on, on], `level ${id}`);
  }
});

test("kA40 is read the same way, and only The Secret Hollow's file sets it", async () => {
  // [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196249-196251] The
  // game forces it on for Dash and the Tower floors at load; the file does not.
  const { parseHeader } = await import("../src/level/decode");
  assert.equal(parseHeader("kA40,1").enable22Changes, true);
  assert.equal(parseHeader("kA40,0").enable22Changes, false);
  assert.equal(parseHeader("").enable22Changes, false);
  const official: Array<[number, boolean]> = [
    [1, false],
    [22, false],
    [5002, false],
    [5004, true],
  ];
  for (const [id, on] of official) {
    const lv = await loadLevel(readFileSync(`${LEVELS}/${id}.txt`, "latin1"));
    assert.equal(lv.header.enable22Changes, on, `level ${id}`);
  }
});

test("kA38, sort every group by x, is read as a switch too", async () => {
  // [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196289-196291]
  const { parseHeader } = await import("../src/level/decode");
  assert.equal(parseHeader("kA38,1").sortAllGroupsX, true);
  assert.equal(parseHeader("kA38,false").sortAllGroupsX, false);
  assert.equal(parseHeader("").sortAllGroupsX, false);
});

// --- the container: cocos2d's base64, zlib, and the raw fallback -------------

test("base64 stops at the first '=', drops a tail it does not pad, and fails a lone character", async () => {
  // [cocos2d::_base64Decode, gd-ida-decomp.cpp:873462-873575]
  const { base64ToBytes } = await import("../src/level/decode");
  const bytes = (s: string) => [...base64ToBytes(s)];
  assert.deepEqual(bytes("QUJD"), [0x41, 0x42, 0x43]);
  assert.deepEqual(bytes("QUI="), [0x41, 0x42], "two bytes padded by one '='");
  assert.deepEqual(bytes("QQ=="), [0x41], "one byte padded by two");
  assert.deepEqual(bytes("QUI"), [], "an unpadded tail is dropped");
  assert.deepEqual(bytes("Q==="), [], "one character before '=' is an error, and an error is empty");
  assert.deepEqual(bytes("QUJD=QUJD"), [0x41, 0x42, 0x43], "nothing after the first '=' counts");
  assert.deepEqual(bytes(" QÍU JD\n"), [0x41, 0x42, 0x43], "characters outside the alphabet are skipped");
  assert.deepEqual(bytes("-_-_"), bytes("+/+/"), "both alphabets count");
  // The table's fill runs to index 64, each alphabet's terminator, so a NUL
  // is worth 64 and carries one into the character before it: J (9) + 1 = K.
  // [:873487-873511]
  assert.deepEqual(bytes("QUJ\u0000"), bytes("QUKA"), "a NUL counts as 64");
  assert.deepEqual(bytes("QUJD\u0000"), [0x41, 0x42, 0x43], "and a lone one at the end is dropped like any short group");
});

test("a level string that is not base64 of gzip or zlib is used as it came", async () => {
  // decompressString hands back its input when the base64 or the inflate
  // fails, and PlayLayer::init only fails an empty result.
  // [cocos2d::ZipUtils::decompressString, gd-ida-decomp.cpp:882878-882963;
  //  PlayLayer::init :107075-107093]
  const { gzipSync, deflateSync } = await import("node:zlib");
  const { decodeLevelString } = await import("../src/level/decode");
  const text = "kS38,1_40_2_125_3_255,kA2,1;1,1,2,15,3,15;";
  const urlSafe = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const gz = urlSafe(gzipSync(Buffer.from(text)));
  assert.equal(await decodeLevelString(gz), text, "gzip");
  assert.equal(await decodeLevelString(urlSafe(deflateSync(Buffer.from(text)))), text, "zlib");
  assert.equal(await decodeLevelString("1,1,2,15,3,15;"), "1,1,2,15,3,15;", "plain objects with no header key");
  assert.equal(await decodeLevelString("H4sIAAAAAAAAAzzzz"), "H4sIAAAAAAAAAzzzz", "a broken gzip stream");
  assert.equal(await decodeLevelString(gz.slice(0, -2)), gz.slice(0, -2), "the padding cut off loses the stream's last byte");
});

test("a broken stream leaves no promise rejecting unheard", async () => {
  const { decodeLevelString } = await import("../src/level/decode");
  const unheard: unknown[] = [];
  const listen = (e: unknown) => void unheard.push(e);
  process.on("unhandledRejection", listen);
  try {
    await decodeLevelString("H4sIAAAAAAAAAzzzz");
    await decodeLevelString("eJzzzzzz");
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", listen);
  }
  assert.deepEqual(unheard, []);
});

// --- objects -------------------------------------------------------------------

test("keys 21 and 22 of 0 or less keep the object's default, and above 1100 read 1101", async () => {
  // [GameObject::objectFromVector, gd-ida-decomp.cpp:184352-184378 →
  //  sub_346CD4 :165199-165208; GJSpriteColor::getColorMode :165461-165470]
  const { parseObject } = await import("../src/level/decode");
  const colours = (s: string) => {
    const o = parseObject(`1,1,2,15,3,15,${s}`, 0)!;
    return [o.baseColor, o.detailColor];
  };
  assert.deepEqual(colours("21,-1,22,0"), [null, null]);
  assert.deepEqual(colours("21,1500,22,1101"), [1101, 1101]);
  assert.deepEqual(colours("21,7.9,22,x"), [7, null], "read with atoi");
  assert.deepEqual(colours("21,5"), [5, null]);
});

test("keys 128 and 129 count only when not 0, and key 32 stands in for both only when both are 0", async () => {
  // [GameObject::objectFromVector :184078-184110]
  const { parseObject } = await import("../src/level/decode");
  const scale = (s: string): [number, number] => {
    const o = parseObject(`1,1,2,15,3,15${s}`, 0)!;
    return [o.scaleX, o.scaleY];
  };
  assert.deepEqual(scale(""), [1, 1]);
  assert.deepEqual(scale(",32,2"), [2, 2]);
  assert.deepEqual(scale(",32,2,128,3"), [3, 1], "one axis set: the other stays 1, whatever key 32 says");
  assert.deepEqual(scale(",32,2,129,0.5"), [1, 0.5]);
  assert.deepEqual(scale(",32,2,128,0,129,0"), [2, 2], "zeros are as good as absent");
  assert.deepEqual(scale(",128,0"), [1, 1]);
  assert.deepEqual(scale(",32,0"), [1, 1]);
});

test("every id from 1964 to 2011 is made as 1964", async () => {
  // [GameObject::objectFromVector :183956-183957]
  const { parseObject } = await import("../src/level/decode");
  assert.equal(parseObject("1,1990,2,15,3,15", 0)?.id, 1964);
  assert.equal(parseObject("1,2011,2,15,3,15", 0)?.id, 1964);
  assert.equal(parseObject("1,2012,2,15,3,15", 0)?.id, 2012);
  assert.equal(parseObject("1,1963,2,15,3,15", 0)?.id, 1963);
});

test("an object switch is read with atoi: on unless 0, missing or not a number", async () => {
  // [GameObject::objectFromVector :184114-184213]
  const { objectFlag, parseObject } = await import("../src/level/decode");
  const o = parseObject("1,1,2,15,3,15,135,1,64,0,67,2,96,true,103,-1", 0)!;
  assert.equal(objectFlag(o, 135), true);
  assert.equal(objectFlag(o, 64), false);
  assert.equal(objectFlag(o, 67), true, "2 is on");
  assert.equal(objectFlag(o, 96), false, "atoi of 'true' is 0");
  assert.equal(objectFlag(o, 103), true);
  assert.equal(objectFlag(o, 200), false, "missing");
});

test("Geometrical Dominator's 66 black sludges with key 21 = -1 take their own black", async () => {
  const lv = await loadLevel(readFileSync(`${LEVELS}/19.txt`, "latin1"));
  const sludges = lv.objects.filter((o) => o.id === 919 && o.props[21] === "-1");
  assert.equal(sludges.length, 66);
  assert.ok(sludges.every((o) => o.baseColor === null));
});

test("a start position keeps its settings block, and every official one is disabled", async () => {
  // Dash has 10 and The Secret Hollow 2; all carry kA21 = 1, so no official
  // level starts from one. [StartPosObject::loadSettingsFromString
  //  :310535-310546; PlayLayer::addObject :90278-90315]
  const { pickStartPosition, parseStartPosition } = await import("../src/level/decode");
  const counts: Array<[number, number, number]> = [];
  for (const id of [22, 5004]) {
    const lv = await loadLevel(readFileSync(`${LEVELS}/${id}.txt`, "latin1"));
    const starts = lv.objects.filter((o) => o.id === 31);
    const pairs = starts.reduce((n, o) => n + Object.keys(o.settings ?? {}).length, 0);
    counts.push([id, starts.length, pairs]);
    assert.ok(starts.every((o) => parseStartPosition(o).disabled), `level ${id}`);
    assert.equal(pickStartPosition(lv), null, `level ${id}`);
    assert.ok(lv.objects.every((o) => o.id === 31 || o.settings === null), `level ${id}: only start positions have a block`);
  }
  assert.deepEqual(counts, [
    [22, 10, 300],
    [5004, 2, 64],
  ]);
  const dash = await loadLevel(readFileSync(`${LEVELS}/22.txt`, "latin1"));
  const fifth = parseStartPosition(dash.objects.filter((o) => o.id === 31)[4]);
  assert.deepEqual(
    [fifth.x, fifth.y, fifth.mode, fifth.speed, fifth.targetOrder, fifth.resetCamera],
    [12165, 705, "ship", 2, 0, true],
  );
});

test("the header's start keys are read the game's way", async () => {
  // Switches with CCString::boolValue, numbers with intValue (atoi).
  // [LevelSettingsObject::objectFromDict :196165-196303; CCString
  //  :797471-797479, :797566-797579]
  const { parseHeader } = await import("../src/level/decode");
  const h = parseHeader("kA2,1.9,kA3,2,kA4,3,kA36,4x,kA29,true,kA20,false,kA27,1,kA41,0,kA42,1");
  assert.deepEqual(
    [h.startMode, h.startSpeed, h.startMini, h.spawnGroup, h.startRotated, h.startReversed],
    ["ship", 3, true, 4, true, false],
  );
  assert.deepEqual([h.allowMultiRotation, h.allowStaticRotate, h.reverseSync], [true, false, true]);
  const none = parseHeader("");
  assert.deepEqual([none.allowMultiRotation, none.allowStaticRotate, none.reverseSync, none.spawnGroup], [false, false, false, 0]);
  // The fades, kA37 and kA39 are switches like the rest: "2" and "true" are on.
  // [objectFromDict :196157-196164 (kA15, kA16), :196285-196287 (kA37),
  //  :196293-196296 (kA39)]
  const more = parseHeader("kA15,2,kA16,true,kA37,2,kA39,true");
  assert.deepEqual([more.fadeIn, more.fadeOut, more.ySections, more.fixRadiusCollision], [true, true, true, true]);
  assert.deepEqual([none.fadeIn, none.fadeOut, none.ySections, none.fixRadiusCollision], [false, false, false, false]);
});

// --- colours -----------------------------------------------------------------

test("key 19 names a 1.x channel and skips keys 21 and 22, whatever it says", async () => {
  // 1-8 → 1005, 1006, 1, 2, 1007, 3, 4, 1003; anything else names nothing,
  // and any value but 0 still skips 21 and 22. [GameObject::objectFromVector,
  //  gd-ida-decomp.cpp:184334-184351; the exe's jump table at RVA 0x19eca8]
  const { parseObject } = await import("../src/level/decode");
  const read = (s: string) => {
    const o = parseObject(`1,1,2,15,3,15,${s}`, 0)!;
    return [o.legacyColor, o.baseColor, o.detailColor];
  };
  const want = [1005, 1006, 1, 2, 1007, 3, 4, 1003];
  for (let k = 1; k <= 8; k++) assert.deepEqual(read(`19,${k}`), [want[k - 1], null, null], `key 19 = ${k}`);
  assert.deepEqual(read("19,5,21,7,22,8"), [1007, null, null], "21 and 22 are not read beside it");
  assert.deepEqual(read("19,9,21,7,22,8"), [null, null, null], "past 8 names nothing, and still skips them");
  assert.deepEqual(read("19,-1,21,7"), [null, null, null], "the index is unsigned");
  assert.deepEqual(read("19,0,21,7,22,8"), [null, 7, 8], "0 is no key 19 at all");
  assert.deepEqual(read("19,2.7"), [1006, null, null], "read with atoi");
});

test("Blast Processing and Theory of Everything 2 colour by key 19", async () => {
  for (const [id, count] of [
    [17, 797],
    [18, 3040],
  ]) {
    const lv = await loadLevel(readFileSync(`${LEVELS}/${id}.txt`, "latin1"));
    assert.equal(lv.objects.filter((o) => o.legacyColor !== null).length, count, `level ${id}`);
  }
});

test("a 1.x header reads all nine keys and makes the line additive", async () => {
  // [LevelSettingsObject::objectFromDict :196335-196412, the line :196364]
  const { parseHeader } = await import("../src/level/decode");
  const h = parseHeader("kS29,1_40_2_125_3_255,kS31,1_255_2_250_3_250_5_0");
  assert.equal(h.colors.get(1002)!.blending, true, "5_0 or not, the line adds");
  assert.deepEqual([h.colors.get(1002)!.r, h.colors.get(1002)!.g, h.colors.get(1002)!.b], [255, 250, 250]);
  // A 1.x key the header leaves out still reads, as an empty entry: black.
  const g = h.colors.get(1001)!;
  assert.deepEqual([g.r, g.g, g.b, g.blending], [0, 0, 0, false]);
  // Levels 1-18 are all 1.x headers, and their line was 5_0.
  for (const id of [1, 17, 18]) {
    const lv = await loadLevel(readFileSync(`${LEVELS}/${id}.txt`, "latin1"));
    assert.equal(lv.header.colors.get(1002)!.blending, true, `level ${id}`);
  }
});

test("kS38 is the whole colour table: the 1.x keys beside it are not read", async () => {
  // [objectFromDict :196317-196333]
  const { parseHeader } = await import("../src/level/decode");
  const h = parseHeader("kS38,1_10_2_20_3_30_6_1|,kS33,1_200_2_200_3_200,kS31,1_9_2_9_3_9");
  assert.deepEqual([h.colors.get(1)!.r, h.colors.get(1)!.g, h.colors.get(1)!.b], [10, 20, 30]);
  const line = h.colors.get(1002)!;
  assert.deepEqual([line.r, line.g, line.b, line.blending], [255, 255, 255, true], "the settings' own line, not kS31's");
});

test("a channel the header leaves out keeps the settings object's colour", async () => {
  // BG (40,125,255), G1 and G2 (0,102,255), the line white and additive,
  // MG and MG2 (40,125,255). [LevelSettingsObject::init :205263-205293]
  const { parseHeader } = await import("../src/level/decode");
  const h = parseHeader("kS38,1_0_2_0_3_0_6_1001|");
  const rgb = (id: number) => {
    const c = h.colors.get(id)!;
    return [c.r, c.g, c.b, c.blending];
  };
  assert.deepEqual(rgb(1000), [40, 125, 255, false]);
  assert.deepEqual(rgb(1001), [0, 0, 0, false], "named, so its own");
  assert.deepEqual(rgb(1009), [0, 102, 255, false], "G2 is not a copy of G1");
  assert.deepEqual(rgb(1002), [255, 255, 255, true]);
  assert.deepEqual(rgb(1013), [40, 125, 255, false]);
  assert.deepEqual(rgb(1014), [40, 125, 255, false]);
});

test("a colour entry reads every field, missing ones as 0, and 7 only with 8 above 0", async () => {
  // [ColorAction::setupFromMap :480349-480501]
  const { parseHeader } = await import("../src/level/decode");
  const h = parseHeader("kS38,6_5_7_0.5|1_1_6_6_7_0.5_8_1|1_1_6_7_5_2|");
  const c5 = h.colors.get(5)!;
  assert.deepEqual([c5.r, c5.g, c5.b, c5.opacity], [0, 0, 0, 1], "no 8: the opacity is 1");
  assert.equal(h.colors.get(6)!.opacity, 0.5);
  assert.equal(h.colors.get(7)!.blending, true, "5 is atof(...) != 0");
});
