// Laying out a line of the game's own bitmap text.
//
// Pure: it takes the parsed `.fnt` data the asset build produced and returns
// where each glyph goes, in design units. Nothing here touches GL, which is
// what makes the wrapping and kerning testable without a browser — and they are
// the parts that go wrong.
//
// Units, not pixels. `FontFile.pxPerUnit` says how many texture pixels one GD
// unit is (4 at uhd), so bigFont's 128 px glyphs are 32 units tall: a heading
// a tenth of the 320-unit screen, which is what the game draws.

import type { Font, FontChar } from "../assets/miscTypes";

export type TextAlign = "left" | "center" | "right";

export interface TextOptions {
  /** Multiplies the font's natural size. 1 is the face at its design size. */
  scale?: number;
  /** Wrap at this width, in units. Omitted means never wrap. */
  maxWidth?: number;
  align?: TextAlign;
  /** Extra units between glyphs, which the game uses to letter-space a title. */
  tracking?: number;
  /** Multiplies the font's own line height. */
  lineSpacing?: number;
}

/** One glyph, placed. `x`/`y` are its bottom-left corner in units. */
export interface Glyph {
  code: number;
  char: FontChar;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which line it belongs to, 0 at the top. Glyphs on one line do not share a
   * `y` — a comma sits lower than a capital — so this is the only way to group
   * them. */
  line: number;
}

export interface TextLayout {
  glyphs: Glyph[];
  width: number;
  height: number;
  lines: number;
}

interface Metrics {
  /** Texture pixels per unit, times the caller's scale. */
  px: number;
  lineHeight: number;
  base: number;
  tracking: number;
}

function metricsFor(font: Font, pxPerUnit: number, opts: TextOptions): Metrics {
  const scale = opts.scale ?? 1;
  const px = pxPerUnit / scale;
  return {
    px,
    lineHeight: (font.lineHeight / px) * (opts.lineSpacing ?? 1),
    base: font.base / px,
    tracking: opts.tracking ?? 0,
  };
}

function kerning(font: Font, prev: number, code: number): number {
  if (prev < 0 || !font.kernings) return 0;
  return font.kernings[`${prev},${code}`] ?? 0;
}

/** How wide one run of characters is, with no wrapping. */
function runWidth(font: Font, codes: readonly number[], m: Metrics): number {
  let w = 0;
  let prev = -1;
  for (const code of codes) {
    const char = font.chars[code];
    if (!char) {
      prev = -1;
      continue;
    }
    w += (char.xa + kerning(font, prev, code)) / m.px + m.tracking;
    prev = code;
  }
  return w;
}

function codesOf(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0) ?? 32);
  return out;
}

/**
 * Splits into lines at explicit breaks and, when `maxWidth` is set, at spaces.
 * A single word too long for the line is broken between characters rather than
 * allowed to run off the edge — a level's text object can and does contain one.
 */
function wrap(font: Font, text: string, m: Metrics, maxWidth: number | undefined): number[][] {
  const lines: number[][] = [];
  for (const raw of text.split("\n")) {
    const codes = codesOf(raw);
    if (maxWidth === undefined || maxWidth <= 0 || runWidth(font, codes, m) <= maxWidth) {
      lines.push(codes);
      continue;
    }
    let line: number[] = [];
    let word: number[] = [];
    const flushWord = (): void => {
      if (word.length === 0) return;
      const candidate = line.length === 0 ? word : [...line, 32, ...word];
      if (runWidth(font, candidate, m) <= maxWidth || line.length === 0) {
        line = candidate;
      } else {
        lines.push(line);
        line = [...word];
      }
      word = [];
    };
    for (const code of codes) {
      if (code === 32) {
        flushWord();
        continue;
      }
      word.push(code);
      // A word on its own that still does not fit: break it here.
      if (line.length === 0 && runWidth(font, word, m) > maxWidth && word.length > 1) {
        const last = word.pop() as number;
        lines.push(word);
        word = [last];
      }
    }
    flushWord();
    if (line.length > 0) lines.push(line);
  }
  return lines.length > 0 ? lines : [[]];
}

/**
 * Places every glyph. The returned box starts at (0, 0) and grows right and
 * up; the caller moves it where it wants, which keeps alignment and anchoring
 * out of here.
 */
export function layout(font: Font, pxPerUnit: number, text: string, opts: TextOptions = {}): TextLayout {
  const m = metricsFor(font, pxPerUnit, opts);
  const lines = wrap(font, text, m, opts.maxWidth);
  const widths = lines.map((codes) => runWidth(font, codes, m));
  const width = widths.length > 0 ? Math.max(...widths) : 0;
  const height = lines.length * m.lineHeight;
  const align = opts.align ?? "left";

  const glyphs: Glyph[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Lines stack downward from the top of the box.
    const top = height - i * m.lineHeight;
    const slack = width - widths[i];
    let pen = align === "center" ? slack / 2 : align === "right" ? slack : 0;
    let prev = -1;
    for (const code of lines[i]) {
      const char = font.chars[code];
      if (!char) {
        prev = -1;
        continue;
      }
      pen += kerning(font, prev, code) / m.px;
      const w = char.w / m.px;
      const h = char.h / m.px;
      // `yo` is measured down from the line's top; `base` is where the baseline
      // sits in that span. Flipping it is what puts the glyph the right way up.
      const y = top - char.yo / m.px - h;
      glyphs.push({ code, char, x: pen + char.xo / m.px, y, w, h, line: i });
      pen += char.xa / m.px + m.tracking;
      prev = code;
    }
  }
  return { glyphs, width, height, lines: lines.length };
}

/** The box `layout` would produce, without placing anything. */
export function measure(font: Font, pxPerUnit: number, text: string, opts: TextOptions = {}): { width: number; height: number; lines: number } {
  const m = metricsFor(font, pxPerUnit, opts);
  const lines = wrap(font, text, m, opts.maxWidth);
  const width = lines.reduce((max, codes) => Math.max(max, runWidth(font, codes, m)), 0);
  return { width, height: lines.length * m.lineHeight, lines: lines.length };
}

/**
 * The scale that makes `text` fit inside `maxWidth` on one line, never growing
 * it past `max`. The game shrinks a long level name this way rather than
 * clipping or wrapping it.
 */
export function scaleToFit(font: Font, pxPerUnit: number, text: string, maxWidth: number, max = 1): number {
  const natural = measure(font, pxPerUnit, text, { scale: 1 }).width;
  if (natural <= 0) return max;
  return Math.min(max, maxWidth / natural);
}
