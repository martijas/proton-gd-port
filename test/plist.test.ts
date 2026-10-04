// The cocos plist reader, on inline documents only: these run on a machine
// without the game installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { array, dict, num, parsePlist, point, rect, size, str } from "../tools/assets/plist";
import type { PlistValue } from "../tools/assets/plist";

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`;

function doc(body: string, before = ""): PlistValue {
  return parsePlist(`${before}${HEADER}\n${body}\n</plist>`);
}

test("reads a sprite frame exactly as the sheets write it", () => {
  const value = doc(`<dict>
  <key>frames</key>
  <dict>
    <key>blackCogwheel_01_001.png</key>
    <dict>
      <key>aliases</key><array/>
      <key>spriteOffset</key><string>{-20,20}</string>
      <key>spriteSize</key><string>{40,40}</string>
      <key>spriteSourceSize</key><string>{80,80}</string>
      <key>textureRect</key><string>{{776,75},{40,40}}</string>
      <key>textureRotated</key><false/>
    </dict>
  </dict>
</dict>`);
  const frames = dict(dict(value, "root").frames, "frames");
  const frame = dict(frames["blackCogwheel_01_001.png"], "frame");
  assert.deepEqual(array(frame.aliases, "aliases"), []);
  assert.deepEqual(point(str(frame.spriteOffset, "offset")), { x: -20, y: 20 });
  assert.deepEqual(size(str(frame.spriteSize, "size")), { w: 40, h: 40 });
  assert.deepEqual(rect(str(frame.textureRect, "rect")), { x: 776, y: 75, w: 40, h: 40 });
  assert.equal(frame.textureRotated, false);
});

test("a rotated frame reads as true", () => {
  const value = doc(`<dict><key>textureRotated</key><true/></dict>`);
  assert.equal(dict(value, "root").textureRotated, true);
});

test("tolerates the stray newline before the declaration that the animation files have", () => {
  const value = doc(`<dict><key>a</key><integer>1</integer></dict>`, "\r\n\r\n");
  assert.equal(num(dict(value, "root").a, "a"), 1);
});

test("integers and reals both read as numbers", () => {
  const value = dict(doc(`<dict><key>i</key><integer>-3</integer><key>r</key><real>0.5</real></dict>`), "root");
  assert.equal(num(value.i, "i"), -3);
  assert.equal(num(value.r, "r"), 0.5);
  // The particle files write the same key both ways, which is why num() exists.
  assert.equal(num("2.5", "string"), 2.5);
});

test("nested dicts inside arrays keep their order", () => {
  const value = doc(`<dict>
  <key>animationContainer</key>
  <array>
    <dict><key>tag</key><integer>1</integer></dict>
    <dict><key>tag</key><integer>2</integer></dict>
  </array>
</dict>`);
  const items = array(dict(value, "root").animationContainer, "container");
  assert.equal(items.length, 2);
  assert.equal(num(dict(items[0], "0").tag, "tag"), 1);
  assert.equal(num(dict(items[1], "1").tag, "tag"), 2);
  assert.deepEqual(Object.keys(dict(items[0], "0")), ["tag"]);
});

test("empty elements do not derail the scanner", () => {
  const value = dict(doc(`<dict><key>a</key><array/><key>b</key><dict/><key>c</key><string></string></dict>`), "root");
  assert.deepEqual(array(value.a, "a"), []);
  assert.deepEqual(dict(value.b, "b"), {});
  assert.equal(str(value.c, "c"), "");
});

test("points tolerate the whitespace the animation files use", () => {
  assert.deepEqual(point("{5.025, -6.725}"), { x: 5.025, y: -6.725 });
  assert.deepEqual(point("{-0.5,0}"), { x: -0.5, y: 0 });
});

test("entities are decoded", () => {
  const value = dict(doc(`<dict><key>t</key><string>a &amp; b &lt;c&gt; &#65;</string></dict>`), "root");
  assert.equal(str(value.t, "t"), "a & b <c> A");
});

test("a malformed document names the problem", () => {
  assert.throws(() => parsePlist(`${HEADER}<dict><key>a</key></dict></plist>`), /has no value/);
  assert.throws(() => parsePlist(`${HEADER}<dict><string>x</string></dict></plist>`), /expected <key>/);
});
