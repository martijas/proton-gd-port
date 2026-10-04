import { spawn } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { builtPath, GD_OUT } from "./tools/paths";

// The build lands in GD_OUT (tools/paths.ts), which is served as plain static
// files. assets/ inside that folder is a copy of the committed prebuilt/assets
// (made by tools/build-assets.ts, not Vite), which is why emptyOutDir stays off.
const here = dirname(fileURLToPath(import.meta.url));
const outDir = GD_OUT;
const prebuiltAssets = builtPath("assets");

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".fnt": "text/plain; charset=utf-8",
};

/** In dev, serves prebuilt/assets at /__gd/assets/ (src/assets/paths.ts, levels.ts). */
function devFolders(): Plugin {
  const mounts: [string, string][] = [["/__gd/assets/", prebuiltAssets]];
  return {
    name: "dev-folders",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]);
        const mount = mounts.find(([prefix]) => path.startsWith(prefix));
        if (!mount) return next();
        const root = resolve(mount[1]);
        const file = normalize(resolve(root, path.slice(mount[0].length)));
        if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        res.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

/** Puts host-config.json next to the page, where the game reads it at start. */
function hostConfig(): Plugin {
  return {
    name: "host-config",
    apply: "build",
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(resolve(here, "host-config.json"), resolve(outDir, "host-config.json"));
    },
  };
}

/**
 * Mirrors prebuilt/assets into GD_OUT/assets: copies what is new or changed
 * (by size and time) and removes what prebuilt/ no longer has, so a rebuild
 * into a folder that already holds the assets costs almost nothing.
 */
function mirrorDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  const wanted = new Set<string>();
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    wanted.add(entry.name);
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mirrorDir(src, dst);
      continue;
    }
    const a = statSync(src);
    const b = existsSync(dst) ? statSync(dst) : null;
    if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) copyFileSync(src, dst);
  }
  for (const name of readdirSync(to)) {
    if (!wanted.has(name)) rmSync(join(to, name), { recursive: true, force: true });
  }
}

function copyAssets(): Plugin {
  return {
    name: "copy-assets",
    apply: "build",
    closeBundle() {
      if (!existsSync(prebuiltAssets)) throw new Error(`${prebuiltAssets} is missing. Run "npm run assets" to make it.`);
      if (resolve(prebuiltAssets) !== resolve(outDir, "assets")) mirrorDir(prebuiltAssets, resolve(outDir, "assets"));
    },
  };
}

/**
 * Clears the script folder before a build. Chunk names carry a content hash, so
 * without this every build leaves its predecessor behind and the served folder
 * fills up with scripts nothing links to. emptyOutDir cannot do the job: it
 * would take assets/ with it.
 */
function cleanScripts(): Plugin {
  return {
    name: "clean-scripts",
    apply: "build",
    buildStart() {
      rmSync(resolve(outDir, "js"), { recursive: true, force: true });
    },
  };
}

/**
 * manualmacro.html's save button, in dev only: the run goes to
 * test/record-manual.ts, which replays it as the tests do and writes the macro.
 */
function manualMacroSave(): Plugin {
  return {
    name: "manual-macro-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__manual-macro/save", (req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const level = Number(url.searchParams.get("level"));
        const seed = Number(url.searchParams.get("seed"));
        const reply = (ok: boolean, message: string): void => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok, message }));
        };
        if (req.method !== "POST" || !Number.isInteger(level) || level <= 0) return reply(false, "That run couldn't be saved.");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const args = ["--import", "tsx", "test/record-manual.ts", String(level)];
          if (Number.isFinite(seed)) args.push(`--seed=${seed}`);
          const child = spawn(process.execPath, args, { cwd: here });
          let out = "";
          child.stdout.on("data", (c: Buffer) => (out += c.toString()));
          child.stderr.on("data", (c: Buffer) => console.warn(c.toString()));
          child.on("close", () => {
            const last = out.trim().split("\n").pop() ?? "";
            try {
              const parsed = JSON.parse(last) as { ok: boolean; message: string };
              reply(parsed.ok, parsed.message);
            } catch {
              reply(false, "Something went wrong checking the run. It wasn't saved.");
            }
          });
          child.stdin.end(Buffer.concat(chunks));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [cleanScripts(), manualMacroSave(), devFolders(), hostConfig(), copyAssets()],
  root: here,
  base: "./",
  publicDir: false,
  // The debug page reads official levels straight from the real install in dev.
  // Online levels go through /api/robtop-server, which dev hands to whatever
  // serves it on GD_DEV_API (by default a Proton Catalog on its usual port).
  server: {
    port: 5199,
    allowedHosts: ["pd.ngrok.dev"],
    proxy: { "/api": process.env.GD_DEV_API || "http://localhost:3000" },
    // Solves and manualmacro.html write these while pages are open; a write must not reload them.
    watch: { ignored: ["**/test/macros/**", "**/test/deadends/**", "**/test/_*"] },
  },
  build: {
    outDir,
    emptyOutDir: false,
    target: "es2022",
    assetsDir: "js",
    rollupOptions: {
      input: {
        main: resolve(here, "index.html"),
        debug: resolve(here, "debug.html"),
        textures: resolve(here, "textures.html"),
        ui: resolve(here, "ui.html"),
        macroverify: resolve(here, "macroverify.html"),
      },
    },
  },
});
