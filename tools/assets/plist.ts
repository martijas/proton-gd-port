// A small XML property-list reader for the cocos2d files in the real install.
//
// Written by hand rather than pulled from npm for two reasons: the project has
// no dependencies, and the files need two kinds of tolerance that a strict
// parser refuses. Eleven of them (every *_AnimDesc*.plist) begin with a stray
// CRLF before the XML declaration, and the geometry strings are written
// inconsistently ("{-20,20}" in a sheet, "{5.025, -6.725}" with a space in an
// animation). Numbers are just as inconsistent: the same key appears as
// <integer> in one particle file and <real> in the next, which is why reading
// goes through the accessors below instead of touching the tree directly.

import { readFileSync } from "node:fs";

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Index just past the ">". */
  end: number;
}

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;

/** Drops the XML declaration, comments and the doctype, plus any leading noise. */
function strip(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "");
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (m, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return m;
  });
}

class Reader {
  private pos = 0;
  constructor(private readonly src: string) {}

  /** Next tag at or after the cursor; null at end of input. */
  nextTag(): Tag | null {
    TAG_RE.lastIndex = this.pos;
    const m = TAG_RE.exec(this.src);
    if (!m) return null;
    this.pos = TAG_RE.lastIndex;
    return { name: m[2], closing: m[1] === "/", selfClosing: m[4] === "/", end: TAG_RE.lastIndex };
  }

  /** Raw text from the cursor up to `</name>`, consuming the closing tag. */
  textUntilClose(name: string): string {
    const close = `</${name}>`;
    const at = this.src.indexOf(close, this.pos);
    if (at < 0) throw new Error(`plist: <${name}> is never closed`);
    const text = this.src.slice(this.pos, at);
    this.pos = at + close.length;
    return decodeEntities(text);
  }

  /** Parses the value that `tag` opens. */
  value(tag: Tag): PlistValue {
    if (tag.closing) throw new Error(`plist: expected a value, saw </${tag.name}>`);
    switch (tag.name) {
      case "true":
        return true;
      case "false":
        return false;
      case "string":
      case "key":
      case "date":
      case "data":
        return tag.selfClosing ? "" : this.textUntilClose(tag.name);
      case "integer":
      case "real": {
        if (tag.selfClosing) return 0;
        const raw = this.textUntilClose(tag.name).trim();
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`plist: <${tag.name}> is not a number: ${raw}`);
        return n;
      }
      case "array": {
        const out: PlistValue[] = [];
        if (tag.selfClosing) return out;
        for (;;) {
          const t = this.nextTag();
          if (!t) throw new Error("plist: <array> is never closed");
          if (t.closing && t.name === "array") return out;
          out.push(this.value(t));
        }
      }
      case "dict": {
        const out: PlistDict = {};
        if (tag.selfClosing) return out;
        for (;;) {
          const t = this.nextTag();
          if (!t) throw new Error("plist: <dict> is never closed");
          if (t.closing && t.name === "dict") return out;
          if (t.name !== "key") throw new Error(`plist: expected <key> inside <dict>, saw <${t.name}>`);
          const key = t.selfClosing ? "" : this.textUntilClose("key");
          const vt = this.nextTag();
          if (!vt || vt.closing) throw new Error(`plist: <key>${key}</key> has no value`);
          out[key] = this.value(vt);
        }
      }
      default:
        throw new Error(`plist: unexpected element <${tag.name}>`);
    }
  }

  /** The document's single root value, skipping the <plist> wrapper. */
  root(): PlistValue {
    for (;;) {
      const t = this.nextTag();
      if (!t) throw new Error("plist: no root value");
      if (t.closing) continue;
      if (t.name === "plist") continue;
      return this.value(t);
    }
  }
}

export function parsePlist(text: string): PlistValue {
  return new Reader(strip(text)).root();
}

export function readPlist(file: string): PlistValue {
  return parsePlist(readFileSync(file, "utf8"));
}

// --- typed accessors ---------------------------------------------------------
// `where` is a key path used in the error, so a bad file names itself.

export function dict(v: PlistValue | undefined, where: string): PlistDict {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where}: expected a dict`);
  return v;
}

export function array(v: PlistValue | undefined, where: string): PlistValue[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected an array`);
  return v;
}

export function str(v: PlistValue | undefined, where: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw new Error(`${where}: expected a string`);
}

export function num(v: PlistValue | undefined, where: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`${where}: expected a number`);
}

export function bool(v: PlistValue | undefined, where: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "1" || v === "YES";
  throw new Error(`${where}: expected a boolean`);
}

export function optNum(v: PlistValue | undefined, fallback: number): number {
  return v === undefined ? fallback : num(v, "value");
}

// --- geometry strings --------------------------------------------------------

function numbers(s: string, count: number, where: string): number[] {
  const parts = s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi);
  if (!parts || parts.length < count) throw new Error(`${where}: expected ${count} numbers in "${s}"`);
  return parts.slice(0, count).map(Number);
}

/** "{-20,20}" or "{5.025, -6.725}". */
export function point(s: string, where = "point"): { x: number; y: number } {
  const [x, y] = numbers(s, 2, where);
  return { x, y };
}

/** "{40,40}". */
export function size(s: string, where = "size"): { w: number; h: number } {
  const [w, h] = numbers(s, 2, where);
  return { w, h };
}

/** "{{776,75},{40,40}}". */
export function rect(s: string, where = "rect"): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = numbers(s, 4, where);
  return { x, y, w, h };
}
