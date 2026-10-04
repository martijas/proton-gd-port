# Geometry Dash port — project rules

This is the browser port of Geometry Dash 2.2. It lives on GitHub at
[martijas/proton-gd-port](https://github.com/martijas/proton-gd-port), and the
working copy is `C:\Users\jason\gd-port`. It ships inside **Proton Catalog**
(`D:\Proxy`), which keeps no copy of this source: on every boot it pulls the
latest `main` from GitHub, builds it, and writes its own host config.

## Getting a change to Proton Catalog

- Commit and push to `main` once the typecheck, tests and build pass. Proton
  Catalog picks the change up the next time it boots, or when someone runs
  `npm run gd:update` in `D:\Proxy`.
- Never edit `D:\Proxy\data\games\src\geometrydash`. That is the catalog's
  clone, and it is reset to GitHub on every update.
- If the push fails, say so in your report; don't leave the change unpushed
  without saying so.

## Paths

- `tools/paths.ts` is the only place that knows where things are.
- The game's art, sound and levels are committed in `prebuilt/assets/`.
  `npm run assets` remakes them from the install in `GD_RESOURCES` (only
  needed when Geometry Dash updates); commit what changes. `npm run build`
  copies them into `GD_OUT` next to the page.
- `GD_RESOURCES` and `GD_OUT` come from the environment, then from `.env`,
  which is not committed. On this machine `.env` points `GD_RESOURCES` at
  `D:\Proxy\Geometry Dash\Resources` and `GD_OUT` at
  `D:\Proxy\data\games\content\bundled\geometrydash`, the folder Proton Catalog
  serves. So a local `npm run build` replaces what the catalog is serving
  until its next update.
- Tests read built assets through `builtPath()` and the official levels
  through `LEVELS_DIR`, both from `tools/paths.ts`.

## Host config

- `host-config.json` (copied next to the page by the build) sets how the game
  reaches RobTop's servers (`direct`, `hostApi` or `autodetect`) and the
  "Hosted by" label. The game reads it at boot (`src/online/hostConfig.ts`) and
  shows it read-only under Settings > Server.
- Proton Catalog writes its own copy, with `autodetect` and "Proton".

## Proton Catalog's rules still apply

The port ships as part of Proton Catalog, so `D:\Proxy\CLAUDE.md` applies here
too. In particular:

- **Version bump:** every change set bumps `CATALOG_UPDATE_NUMBER` in
  `D:\Proxy\client\src\version.ts` by exactly 1. Bump last, from the value on
  disk at that moment.
- **UI copy:** anything a player can see is written for the player — plain,
  short, and never naming the plumbing.
- The product is called **Proton Catalog**.

## Commands

- `npx tsc --noEmit -p .` — typecheck
- `npm test` — tests
- `npm run build` — build into `GD_OUT`
- `npm run assets` (`-- --only=<step>`) — rebuild the game's assets
- `npm run dev` — dev server on port 5199
- `npm start` — serve `GD_OUT` with the `/api/robtop-server` tunnel

The reference decompile is `data/ref/gd-ida-decomp.cpp`.
