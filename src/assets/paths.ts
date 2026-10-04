/// <reference types="vite/client" />

/**
 * Where the built assets are.
 *
 * The production build sits next to them, so the URL is just `assets/...`. In
 * dev the page is served from the source tree, so it reaches the same built
 * files through the dev server's /__gd/out/ mount (vite.config.ts). Both
 * branches therefore read exactly the bytes that ship, which is the point: a
 * debug page that reads the originals instead would not be checking the
 * pipeline at all.
 */
const DEV_ASSETS = "/__gd/out/assets";

export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return import.meta.env.DEV ? `${DEV_ASSETS}/${encodeURI(clean)}` : `assets/${clean}`;
}

/** Fetches JSON from assets/, with a message a person can act on. */
export async function fetchAsset<T>(path: string): Promise<T> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`${path} could not be loaded (${res.status}). Run the asset build first.`);
  return (await res.json()) as T;
}
