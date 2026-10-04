import type {
  ColorChannel,
  GameMode,
  HsvShift,
  Level,
  LevelHeader,
  LevelObject,
  Speed,
  StartPosition,
} from "./types";

// ---------------------------------------------------------------------------
// Level strings: base64 (URL-safe alphabet) of a gzip stream of the plain
// `key,value,…;id,x,…;` text. Official level files are exactly that string;
// most start with four spaces and end with a newline, which the decoder skips,
// and 22.txt, 5001.txt, 5002.txt and 5003.txt carry a NUL (the last two a
// stray byte too) after the padding, which it never reaches.
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
B64_LOOKUP["-".charCodeAt(0)] = 62;
B64_LOOKUP["_".charCodeAt(0)] = 63;
// The table is filled from index 64 down, and index 64 of either alphabet is
// the string's own terminator: a NUL is a character worth 64. [the fill loops
// :873487-873511; libcocos2d.dll holds both alphabets NUL-terminated]
B64_LOOKUP[0] = 64;
const B64_PAD = 61; // "="

/**
 * cocos2d's base64 decoder as the game ships it. Characters outside the
 * alphabet are skipped — both alphabets count, because the game's table is one
 * static that the standard and the url-safe decoders both fill — except a NUL,
 * which the table holds as 64 and which so carries into the character before
 * it. The first "=" ends the data and pads the group before it; a group left
 * short without one is dropped. A lone character before the "=" is an error,
 * and the game reads an error and no data alike: both come back empty here.
 * [cocos2d::_base64Decode, gd-ida-decomp.cpp:873462-873575; base64Decode
 *  :873710-873724, which frees the output on an error]
 */
export function base64ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let acc = 0;
  let count = 0;
  let n = 0;
  let padded = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === B64_PAD) {
      padded = true;
      break;
    }
    const v = c < 256 ? B64_LOOKUP[c] : -1;
    if (v < 0) continue;
    // Added, then shifted unless the group is full, as the game does it.
    acc += v;
    if (++count === 4) {
      out[n++] = (acc >> 16) & 0xff;
      out[n++] = (acc >> 8) & 0xff;
      out[n++] = acc & 0xff;
      acc = 0;
      count = 0;
    } else {
      acc <<= 6;
    }
  }
  if (padded) {
    if (count === 1) return new Uint8Array(0);
    if (count === 2) out[n++] = (acc >> 10) & 0xff;
    if (count === 3) {
      out[n++] = (acc >> 16) & 0xff;
      out[n++] = (acc >> 8) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/**
 * zlib's inflate, or null when the stream is bad or ends early. The stream
 * has to be read to its end here, and a rejected write or close is caught, so
 * a bad level never leaves a promise rejecting with no one listening.
 */
async function inflate(bytes: Uint8Array, format: "gzip" | "deflate"): Promise<Uint8Array | null> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(bytes as unknown as BufferSource).catch(() => undefined);
  writer.close().catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    return null;
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Turns whatever a level file or server response holds into the plain `k…;`
 * text. The game runs every level through the same steps and keeps the input
 * as it came whenever one of them fails: no base64, or a stream that is
 * neither gzip nor zlib or does not inflate. Only an empty result fails the
 * level. Plain text that starts with a header key skips the attempt: its first
 * decoded byte would be 0x90-0x93, which is no gzip or zlib header.
 * [cocos2d::ZipUtils::decompressString, gd-ida-decomp.cpp:882878-882963;
 *  ccInflateMemoryWithHint :882623-882690, windowBits 47 (gzip or zlib);
 *  PlayLayer::init :107075-107093]
 */
export async function decodeLevelString(raw: string): Promise<string> {
  const trimmed = raw.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("kS") || trimmed.startsWith("kA")) return trimmed;
  const bytes = base64ToBytes(trimmed);
  if (bytes.length === 0) return trimmed;
  const plain = await inflate(bytes, bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "deflate");
  if (!plain || plain.length === 0) return trimmed;
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const MODE_BY_KA2: GameMode[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"];
// kA4: 0 = normal, 1 = slow, 2 = fast, 3 = faster, 4 = fastest.
const SPEED_BY_KA4: Speed[] = [1, 0, 2, 3, 4];

/**
 * CCString::boolValue, which every switch in a settings block is read with:
 * anything but a missing or empty value, "0" or "false" is on.
 * [gd-ida-decomp.cpp:797566-797579]
 */
function ccBool(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** CCString::intValue: atoi, so the leading integer and 0 for none. [gd-ida-decomp.cpp:797471-797479] */
function ccInt(v: string | undefined): number {
  return v === undefined ? 0 : parseInt(v, 10) || 0;
}

/**
 * An object's integer key as objectFromVector reads it: atoi of the value,
 * 0 for a missing key. [GameObject::objectFromVector, gd-ida-decomp.cpp:
 *  183768-184388]
 */
export function objectInt(o: LevelObject, key: number): number {
  return ccInt(o.props[key]);
}

/**
 * An object switch as objectFromVector reads it: atoi of the value, on when
 * it is not 0. A missing key is off, and so is "true".
 * [GameObject::objectFromVector, gd-ida-decomp.cpp:184114-184213]
 */
export function objectFlag(o: LevelObject, key: number): boolean {
  return ccInt(o.props[key]) !== 0;
}

/** The per-object keys the renderer reads. [objectFromVector :184028-184213] */
export const OBJECT_KEY = {
  /** Don't fade (+899 → +891). */
  dontFade: 64,
  /** Don't enter (+898 → +890). */
  dontEnter: 67,
  /** No glow (+876). */
  noGlow: 96,
  /**
   * A turning object's own speed in degrees a second (+1204, atof) and its
   * off switch (+1200). [EnhancedGameObject::customObjectSetup :181789-181798]
   */
  rotationSpeed: 97,
  noRotation: 98,
  /** Animation: random start (+1220), speed (+1224), use speed (+1228). */
  randomStart: 106,
  animSpeed: 107,
  useSpeed: 122,
  /** Animate on trigger (+1229). */
  animateOnTrigger: 123,
  /** Disable the freeze pause (+1230). */
  noDelayedLoop: 126,
  /** Special-animation objects: no recolour flash on frame 1 (+1231). */
  disableAnimShine: 127,
  /** Hide (+1106 → +855 in play). */
  hide: 135,
  /**
   * A Custom Particles object's colours from its object: key 146 for the
   * start and end colours (+669), key 147 for the uniform ramp (+1536).
   * [ParticleGameObject::customObjectSetup :306001-306008]
   */
  particleUsesObjectColour: 146,
  particleUsesUniformColour: 147,
  /** An Animate trigger reaches the object only while it is active (+1252). [:181833-181836] */
  animateActiveOnly: 214,
  /** Enter channel (+868), 0-100. */
  enterChannel: 343,
  /** Stops a pulsing object pulsing to the music (+825). [objectFromVector :184179] */
  noAudioScale: 372,
  /** Single frame (+1232) and offset animation (+1236). */
  singleFrame: 462,
  offsetAnim: 592,
} as const;

/**
 * kA2 and kA4, read as ints. A mode past the end starts as a cube and a speed
 * past the end at 1x: setupLevelStart's switches fall through to both.
 * [LevelSettingsObject::objectFromDict :196165-196167, :196197-196199;
 *  GJBaseGameLayer::setupLevelStart :462758-462815]
 */
function modeOf(raw: Record<string, string>): GameMode {
  return MODE_BY_KA2[ccInt(raw.kA2)] ?? "cube";
}

function speedOf(raw: Record<string, string>): Speed {
  return SPEED_BY_KA4[ccInt(raw.kA4)] ?? 1;
}

/**
 * What a level's colours are before its header says anything: a new
 * LevelSettingsObject's, which is what the header is read into. A channel the
 * header leaves out keeps these; every other one is white.
 * [LevelSettingsObject::init, gd-ida-decomp.cpp:205263-205293; objectFromDict
 *  starts from one, :196143]
 */
const SETTINGS_COLORS: readonly (readonly [id: number, r: number, g: number, b: number, blending: boolean])[] = [
  [1000, 40, 125, 255, false], // BG
  [1001, 0, 102, 255, false], // G1
  [1009, 0, 102, 255, false], // G2
  [1002, 255, 255, 255, true], // the line, additive
  [1013, 40, 125, 255, false], // MG
  [1014, 40, 125, 255, false], // MG2
];

/** 1.x colour keys → the 2.x channel they stand for. */
const LEGACY_COLOR_KEYS: Record<string, number> = {
  kS29: 1000, // BG
  kS30: 1001, // ground
  kS31: 1002, // line
  kS32: 1004, // object
  kS33: 1, // colour 1
  kS34: 2, // colour 2
  kS35: 3,
  kS36: 4,
  kS37: 1003, // 3DL
};

function parseHsv(s: string | undefined): HsvShift | null {
  if (!s) return null;
  const p = s.split("a");
  if (p.length < 5) return null;
  return {
    h: Number(p[0]) || 0,
    s: Number(p[1]) || 0,
    v: Number(p[2]) || 0,
    sChecked: p[3] === "1",
    vChecked: p[4] === "1",
  };
}

/**
 * One colour entry, `key_value` pairs. Every field is read whether or not it
 * is there, and a missing one reads as atoi or atof of nothing: 0. So a
 * missing colour is black, and the opacity (7) counts only when 8 is above 0.
 * [ColorAction::setupFromMap, gd-ida-decomp.cpp:480349-480501]
 */
function parseColorEntry(entry: string, fallbackId: number): ColorChannel | null {
  const parts = entry.split("_");
  const kv: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) kv[parts[i]] = parts[i + 1];
  const id = kv["6"] !== undefined ? Number(kv["6"]) : fallbackId;
  if (!Number.isFinite(id) || id <= 0) return null;
  const num = (k: string): number => parseFloat(kv[k] ?? "") || 0;
  return {
    id,
    r: ccInt(kv["1"]),
    g: ccInt(kv["2"]),
    b: ccInt(kv["3"]),
    opacity: ccInt(kv["8"]) > 0 ? num("7") : 1,
    blending: num("5") !== 0,
    copyId: ccInt(kv["9"]),
    copyHsv: parseHsv(kv["10"]),
    copyOpacity: ccInt(kv["17"]) !== 0,
    playerColor: kv["4"] === "1" ? 1 : kv["4"] === "2" ? 2 : 0,
  };
}

export function parseHeader(segment: string): LevelHeader {
  const parts = segment.split(",");
  const raw: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) raw[parts[i]] = parts[i + 1];

  const colors = new Map<number, ColorChannel>();
  for (const [id, r, g, b, blending] of SETTINGS_COLORS) {
    colors.set(id, { id, r, g, b, opacity: 1, blending, copyId: 0, copyHsv: null, copyOpacity: false, playerColor: 0 });
  }
  // kS38 is the whole table and the 1.x keys are not read beside it. Without
  // it, kS29 means all nine 1.x keys are read, and the line is then made
  // additive whatever its entry says; the pre-1.9 kS1 table does the same.
  // [objectFromDict :196317-196333 (kS38), :196335-196412 (kS29-kS37, the line
  //  :196364); setupColorsFromLegacyMode :196011-196013 for kS1]
  if (raw.kS38 !== undefined) {
    for (const entry of raw.kS38.split("|")) {
      if (!entry) continue;
      const c = parseColorEntry(entry, 0);
      if (c) colors.set(c.id, c);
    }
  } else if (raw.kS29 !== undefined) {
    for (const key of Object.keys(LEGACY_COLOR_KEYS)) {
      const id = LEGACY_COLOR_KEYS[key];
      const c = parseColorEntry(raw[key] ?? "", id);
      if (c) colors.set(id, { ...c, id, blending: c.blending || id === 1002 });
    }
  }

  const guidelines: number[] = [];
  if (raw.kA14) {
    const g = raw.kA14.split("~");
    for (let i = 0; i + 1 < g.length; i += 2) {
      const t = Number(g[i]);
      if (Number.isFinite(t)) guidelines.push(t);
    }
  }

  const num = (k: string, d = 0) => {
    const v = Number(raw[k]);
    return Number.isFinite(v) ? v : d;
  };
  const on = (k: string) => ccBool(raw[k]);

  return {
    startMode: modeOf(raw),
    startSpeed: speedOf(raw),
    startMini: on("kA3"),
    startDual: on("kA8"),
    startFlipped: on("kA11"),
    startReversed: on("kA20"),
    startRotated: on("kA29"),
    spawnGroup: ccInt(raw.kA36),
    twoPlayer: on("kA10"),
    platformer: on("kA22"),
    playerSqueeze: on("kA31"),
    fixGravityBug: on("kA32"),
    fixRobotJump: on("kA34"),
    enable22Changes: on("kA40"),
    sortAllGroupsX: on("kA38"),
    ySections: on("kA37"),
    fixRadiusCollision: on("kA39"),
    allowMultiRotation: on("kA27"),
    allowStaticRotate: on("kA41"),
    reverseSync: on("kA42"),
    fixNegativeScale: on("kA33"),
    lengthSteps: ccInt(raw.kA44),
    decreaseBoostSlide: on("kA45"),
    leftStopAlways: on("kA23"),
    noLeftStop: on("kA24"),
    songOffset: num("kA13"),
    fadeIn: on("kA15"),
    fadeOut: on("kA16"),
    // kA6/kA7 are 1-based, and 0 means the level never chose — every level up
    // to Cant Let Go leaves both at 0 and gets the first background and ground.
    // [meas: levels 1-14 write 0, 15 onward write a real id]
    background: num("kA6") || 1,
    ground: num("kA7") || 1,
    groundLine: num("kA17"),
    font: num("kA18"),
    guidelines,
    colors,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * Key 19's channels, for 1 to 8; anything else names none. The game keeps
 * them in a word table the decompile does not show; the exe's switch over
 * the same eight cases loads 1005, 1006, 1, 2, 1007, 3, 4 and 1003.
 * [objectFromVector :184337-184342 (the index is unsigned, so 0 and below
 *  fall out with the rest); GeometryDash.exe jump table at RVA 0x19eca8]
 */
const LEGACY_OBJECT_COLORS: readonly number[] = [1005, 1006, 1, 2, 1007, 3, 4, 1003];

export function parseObject(segment: string, index: number): LevelObject | null {
  const parts = segment.split(",");
  if (parts.length < 4) return null;
  const props: Record<number, string> = {};
  let settings: Record<string, string> | null = null;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const k = Number(parts[i]);
    if (Number.isFinite(k)) props[k] = parts[i + 1];
    else (settings ??= {})[parts[i]] = parts[i + 1];
  }
  const read = Number(props[1]);
  if (!Number.isFinite(read)) return null;
  // Every id from 1964 to 2011 is made as 1964. [GameObject::objectFromVector
  //  :183956-183957]
  const id = read >= 1964 && read <= 2011 ? 1964 : read;
  // Keys 128 and 129 count only when they are not 0, and key 32 stands in
  // for both, and only when both are 0: one axis set on its own leaves the
  // other at 1 whatever key 32 says. [objectFromVector :184078-184110]
  const scaleKey = (k: number): number => (props[k] !== undefined ? Number.parseFloat(props[k]) || 0 : 0);
  const keyX = scaleKey(128);
  const keyY = scaleKey(129);
  const both = keyX === 0 && keyY === 0 ? scaleKey(32) : 0;
  const scaleX = keyX !== 0 ? keyX : both !== 0 ? both : 1;
  const scaleY = keyY !== 0 ? keyY : both !== 0 ? both : 1;
  const groups: number[] = [];
  if (props[57]) {
    for (const g of props[57].split(".")) {
      const n = Number(g);
      if (Number.isFinite(n) && n > 0) groups.push(n);
    }
  }
  const opt = (k: number): number | null => (props[k] !== undefined ? Number(props[k]) : null);
  // Key 19 first: any value but 0 means the object is coloured the 1.x way
  // and keys 21 and 22 are never read, whether or not it names a channel.
  // [GameObject::objectFromVector, gd-ida-decomp.cpp:184334-184351]
  const legacy = ccInt(props[19]);
  // Keys 21 and 22 are clamped as they are read: 0 or less keeps the
  // object's default channel, anything above 1100 is 1101.
  // [GameObject::objectFromVector, gd-ida-decomp.cpp:184352-184378 →
  //  sub_346CD4 :165199-165208; GJSpriteColor::getColorMode :165461-165470]
  const channel = (k: number): number | null => {
    if (legacy !== 0 || props[k] === undefined) return null;
    const c = ccInt(props[k]);
    return c > 1100 ? 1101 : c > 0 ? c : null;
  };
  return {
    index,
    id,
    x: Number(props[2]) || 0,
    y: Number(props[3]) || 0,
    rotation: Number(props[6]) || 0,
    flipX: props[4] === "1",
    flipY: props[5] === "1",
    scaleX,
    scaleY,
    groups,
    zLayer: opt(24),
    zOrder: opt(25),
    baseColor: channel(21),
    detailColor: channel(22),
    legacyColor: LEGACY_OBJECT_COLORS[legacy - 1] ?? null,
    // The shift only counts when its own checkbox is set: levels carry a stale
    // value on plenty of objects that do not use it.
    baseHsv: props[41] === "1" ? parseHsv(props[43]) : null,
    detailHsv: props[42] === "1" ? parseHsv(props[44]) : null,
    editorLayer: opt(20),
    props,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Start positions
// ---------------------------------------------------------------------------

/** The start position object (physics/objectData.ts START_POS_ID). */
const START_POS_ID = 31;

/**
 * A start position's settings block, read with the same getters as a header.
 * A missing key reads as 0 or off, so a start position with no block is an
 * enabled 1x cube with target order 0.
 * [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196140-196320:
 *  kA19 :196231, kA26 :196235, kA20 :196239, kA21 :196243, kA35 :196299]
 */
export function parseStartPosition(o: LevelObject): StartPosition {
  const raw = o.settings ?? {};
  return {
    index: o.index,
    x: o.x,
    y: o.y,
    mode: modeOf(raw),
    speed: speedOf(raw),
    mini: ccBool(raw.kA3),
    dual: ccBool(raw.kA8),
    flipped: ccBool(raw.kA11),
    reversed: ccBool(raw.kA20),
    rotated: ccBool(raw.kA29),
    platformer: ccBool(raw.kA22),
    disabled: ccBool(raw.kA21),
    targetOrder: ccInt(raw.kA19),
    targetChannel: ccInt(raw.kA26),
    resetCamera: ccBool(raw.kA35),
  };
}

/**
 * The start position a run begins from, or null. Objects are met in level
 * order and a disabled one is passed over. One wins over the best so far with
 * a higher target order, or with the same order and further along — further
 * right, or further left when it is itself reversed; a tie in x keeps the
 * first. The best so far starts at order -1, x 0. The editor's playtest picks
 * the same way.
 * [PlayLayer::addObject, gd-ida-decomp.cpp:90278-90315; LevelEditorLayer::
 *  findStartPosObject :191606-191681]
 */
export function pickStartPosition(level: Level): StartPosition | null {
  let best: StartPosition | null = null;
  let bestOrder = -1;
  let bestX = 0;
  for (const o of level.objects) {
    if (o.id !== START_POS_ID) continue;
    const sp = parseStartPosition(o);
    if (sp.disabled) continue;
    const further = sp.reversed ? sp.x < bestX : sp.x > bestX;
    if (sp.targetOrder > bestOrder || (sp.targetOrder === bestOrder && further)) {
      best = sp;
      bestOrder = sp.targetOrder;
      bestX = sp.x;
    }
  }
  return best;
}

/** Parses the plain (already decompressed) level text. */
export function parseLevel(plain: string): Level {
  const segments = plain.split(";");
  const header = parseHeader(segments[0] ?? "");
  const objects: LevelObject[] = [];
  let maxX = 0;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const o = parseObject(seg, objects.length);
    if (!o) continue;
    objects.push(o);
    if (o.x > maxX) maxX = o.x;
  }
  return { header, objects, lengthUnits: maxX + 30 * 12 };
}

export async function loadLevel(raw: string): Promise<Level> {
  return parseLevel(await decodeLevelString(raw));
}
