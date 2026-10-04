// A small server for hosting the built game yourself:
//
//   npm start            (PORT, default 8080; GD_OUT, default dist/)
//
// It serves the built folder as static files and answers /api/robtop-server/*,
// the tunnel the game's "autodetect" server mode looks for on the host it was
// loaded from. No dependencies beyond Node 20+.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function dotEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const env = { ...dotEnv(), ...process.env };
const outSetting = env.GD_OUT || "dist";
const OUT = isAbsolute(outSetting) ? outSetting : resolve(ROOT, outSetting);
const PORT = Number(env.PORT) || 8080;

const ROBTOP = "https://www.boomlings.com/database/";
/** The read-only endpoints the game uses; nothing else is passed on. */
const ENDPOINTS = new Set([
  "getGJLevels21.php",
  "downloadGJLevel22.php",
  "getGJMapPacks21.php",
  "getGJGauntlets21.php",
  "getGJSongInfo.php",
  "getGJUsers20.php",
]);
const AUDIO_HOSTS = [/(^|\.)ngfiles\.com$/, /^geometrydashfiles\.b-cdn\.net$/, /^geometrydashcontent\.b-cdn\.net$/];
const MAX_FORM_BYTES = 8 * 1024;
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;
const OFFLINE = "The level servers aren't answering right now. Try again in a bit.";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".fnt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function cors(res) {
  // Other sites may point their "host API" mode here.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function fail(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message }));
}

function readForm(req) {
  return new Promise((done, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_FORM_BYTES) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function tunnel(req, res, endpoint) {
  if (!ENDPOINTS.has(endpoint)) return fail(res, 404, "That isn't something the game asks for.");
  if (req.method !== "POST") return fail(res, 405, "Send the form as a POST.");
  let form;
  try {
    form = await readForm(req);
  } catch {
    return fail(res, 413, "That request is too big.");
  }
  try {
    const upstream = await fetch(ROBTOP + endpoint, {
      method: "POST",
      // The servers refuse browser user agents; the game sends none.
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "", Accept: "*/*" },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) return fail(res, 502, OFFLINE);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  } catch {
    fail(res, 502, OFFLINE);
  }
}

async function audio(req, res, raw) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    return fail(res, 400, "This sound isn't available.");
  }
  url.protocol = "https:";
  if (!AUDIO_HOSTS.some((re) => re.test(url.hostname))) return fail(res, 404, "This sound isn't available.");
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const length = Number(upstream.headers.get("content-length") ?? 0);
    if (!upstream.ok || !upstream.body || length > MAX_AUDIO_BYTES) return fail(res, 404, "This sound isn't available.");
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "public, max-age=604800",
      ...(length > 0 ? { "Content-Length": String(length) } : {}),
    });
    let sent = 0;
    const body = Readable.fromWeb(upstream.body);
    body.on("data", (c) => {
      sent += c.length;
      if (sent > MAX_AUDIO_BYTES) body.destroy();
    });
    body.on("error", () => res.destroy());
    res.on("close", () => body.destroy());
    body.pipe(res);
  } catch {
    if (res.headersSent) res.destroy();
    else fail(res, 502, OFFLINE);
  }
}

function serveFile(req, res, pathname) {
  const root = resolve(OUT);
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (file !== root && !file.startsWith(root + sep)) return fail(res, 403, "Not here.");
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) return fail(res, 404, "Not found.");
  const headers = { "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" };
  // The host config is meant to be edited in place, so it is never cached.
  if (file.endsWith("host-config.json")) headers["Cache-Control"] = "no-store";
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const tunnelMatch = /^\/api\/robtop-server\/(.+)$/.exec(url.pathname);
  if (tunnelMatch) {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (tunnelMatch[1] === "audio") return void audio(req, res, url.searchParams.get("url"));
    return void tunnel(req, res, tunnelMatch[1]);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Not here.");
  serveFile(req, res, url.pathname);
});

if (!existsSync(join(OUT, "index.html"))) {
  console.warn(`Nothing built in ${OUT} yet. Run "npm run assets" and "npm run build" first.`);
}
server.listen(PORT, () => console.log(`Geometry Dash on http://localhost:${PORT} (serving ${OUT})`));
