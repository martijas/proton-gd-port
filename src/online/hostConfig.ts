// How whoever hosts this copy of the game set it up: host-config.json beside
// the page, read once at boot. Players can see it (Settings > Server) but not
// change it.

/** Where requests for the game's own servers go. */
export type ServerMode = "direct" | "hostApi" | "autodetect";

export interface HostConfig {
  server: { mode: ServerMode; hostApi: string };
  /** Shown under the home screen's play button; empty hides it. */
  hostedBy: string;
}

/** RobTop's own servers, which browsers can't call from another site. */
export const ROBTOP_DIRECT = "https://www.boomlings.com/database";
/** Where autodetect looks on the host the game is running on. */
export const TUNNEL_PATH = "/api/robtop-server";

export const DEFAULT_HOST_CONFIG: HostConfig = { server: { mode: "autodetect", hostApi: "" }, hostedBy: "" };

let current: HostConfig = DEFAULT_HOST_CONFIG;

/** Turns whatever the file holds into a config; anything unusable falls back to the default. */
export function parseHostConfig(raw: unknown): HostConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_HOST_CONFIG;
  const r = raw as { server?: { mode?: unknown; hostApi?: unknown }; hostedBy?: unknown };
  const hostApi = typeof r.server?.hostApi === "string" ? r.server.hostApi.trim().replace(/\/+$/, "") : "";
  let mode: ServerMode = r.server?.mode === "direct" || r.server?.mode === "hostApi" ? r.server.mode : "autodetect";
  if (mode === "hostApi" && !/^https?:\/\//i.test(hostApi)) mode = "autodetect";
  const hostedBy = typeof r.hostedBy === "string" ? r.hostedBy.trim().slice(0, 40) : "";
  return { server: { mode, hostApi: mode === "hostApi" ? hostApi : "" }, hostedBy };
}

/** Reads host-config.json. A missing or broken file leaves the default in place. */
export async function loadHostConfig(): Promise<HostConfig> {
  try {
    const res = await fetch("host-config.json", { cache: "no-store" });
    current = res.ok ? parseHostConfig(await res.json()) : DEFAULT_HOST_CONFIG;
  } catch {
    current = DEFAULT_HOST_CONFIG;
  }
  return current;
}

export function hostConfig(): HostConfig {
  return current;
}

/** For tests. */
export function setHostConfig(config: HostConfig): void {
  current = config;
}

/** The base every server request is made against, without a trailing slash. */
export function serverBase(config: HostConfig = current, origin = globalThis.location?.origin ?? ""): string {
  switch (config.server.mode) {
    case "direct":
      return ROBTOP_DIRECT;
    case "hostApi":
      return config.server.hostApi;
    default:
      return origin + TUNNEL_PATH;
  }
}
