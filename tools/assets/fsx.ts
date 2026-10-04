// File helpers shared by every build step. Nothing here decodes an image: PNG
// dimensions come straight out of the IHDR header, which is all the copy steps
// need to describe what they shipped.

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface FileStamp {
  /** Absolute path. */
  path: string;
  mtimeMs: number;
  size: number;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function stampOf(path: string): FileStamp | null {
  try {
    const s = statSync(path);
    return { path, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Files directly inside `dir` matching `test`, sorted by name. Missing dir = []. */
export function listFiles(dir: string, test?: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
  if (test) names = names.filter(test);
  names.sort();
  return names;
}

/** Every file under `dir`, recursively, as paths relative to `dir`. */
export function walkFiles(dir: string, out: string[] = [], base = dir): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, base);
    else if (e.isFile()) out.push(relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Copy only when the destination is missing or differs in size or mtime, and
 * carry the source mtime over so the next run can tell.
 */
export function copyIfChanged(src: string, dest: string): { copied: boolean; bytes: number } {
  const from = statSync(src);
  const to = stampOf(dest);
  if (to && to.size === from.size && Math.abs(to.mtimeMs - from.mtimeMs) < 1) return { copied: false, bytes: from.size };
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  utimesSync(dest, from.atime, from.mtime);
  return { copied: true, bytes: from.size };
}

/** Writes only when the bytes differ, so untouched outputs keep their mtime. */
export function writeIfChanged(dest: string, contents: string | Buffer): { written: boolean; bytes: number } {
  const buf = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  if (existsSync(dest)) {
    try {
      const old = readFileSync(dest);
      if (old.equals(buf)) return { written: false, bytes: buf.length };
    } catch {
      /* fall through and write */
    }
  }
  ensureDir(dirname(dest));
  writeFileSync(dest, buf);
  return { written: true, bytes: buf.length };
}

/** JSON with a trailing newline; `pretty` keeps generated data diffable. */
export function writeJson(dest: string, value: unknown, pretty = false): { written: boolean; bytes: number } {
  return writeIfChanged(dest, JSON.stringify(value, null, pretty ? 1 : 0) + "\n");
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk, without decoding a single pixel. */
export function pngSize(path: string): { w: number; h: number } {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(24);
    const read = readSync(fd, head, 0, 24, 0);
    if (read < 24 || !head.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`Not a PNG: ${path}`);
    if (head.subarray(12, 16).toString("latin1") !== "IHDR") throw new Error(`PNG without IHDR: ${path}`);
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/** Size in bytes, or 0 when the file is not there. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Stable hash of file contents, for the "did the generator itself change" check. */
export function hashFiles(paths: string[]): string {
  const h = createHash("sha1");
  for (const p of paths.slice().sort()) {
    h.update(p);
    try {
      h.update(readFileSync(p));
    } catch {
      h.update("<missing>");
    }
  }
  return h.digest("hex").slice(0, 16);
}

export function hashValue(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Absolute path inside the real install; `join` so the space in the folder name is safe. */
export function srcPath(root: string, ...parts: string[]): string {
  return resolve(join(root, ...parts));
}
