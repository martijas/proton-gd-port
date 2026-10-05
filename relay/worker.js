// The relay the GitHub Pages copy of the game reaches RobTop's servers through.
// Browsers won't read boomlings.com's replies from another site, so this
// Cloudflare Worker passes the game's requests on and answers with the header
// that lets them through. It does what server/serve.mjs's /api/robtop-server
// tunnel does, for a host with no server of its own.
//
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Worker, paste this
// file over the starter code, Deploy. Or `npx wrangler deploy` in this folder.
// Then set .github/pages/host-config.json to
//   { "server": { "mode": "hostApi", "hostApi": "https://<worker>.workers.dev" }, ... }
//
// The game posts to <hostApi>/<endpoint>.php and fetches songs from
// <hostApi>/audio?url=<song address>.

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
/** The sites allowed to use the relay. Anything else gets no CORS header, so a browser there can't read the reply. */
const ORIGINS = [/^https:\/\/martijas\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const MAX_FORM_BYTES = 8 * 1024;
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;
const OFFLINE = "The level servers aren't answering right now. Try again in a bit.";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") ?? "";
  if (!ORIGINS.some((re) => re.test(origin))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function fail(status, message, cors) {
  return new Response(JSON.stringify({ message }), { status, headers: { "Content-Type": "application/json", ...cors } });
}

async function tunnel(request, endpoint, cors) {
  if (!ENDPOINTS.has(endpoint)) return fail(404, "That isn't something the game asks for.", cors);
  if (request.method !== "POST") return fail(405, "Send the form as a POST.", cors);
  const form = await request.text();
  if (form.length > MAX_FORM_BYTES) return fail(413, "That request is too big.", cors);
  try {
    const upstream = await fetch(ROBTOP + endpoint, {
      method: "POST",
      // The servers refuse browser user agents; the game sends none.
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "", Accept: "*/*" },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    if (!upstream.ok) return fail(502, OFFLINE, cors);
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...cors } });
  } catch {
    return fail(502, OFFLINE, cors);
  }
}

async function audio(raw, cors) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    return fail(400, "This sound isn't available.", cors);
  }
  url.protocol = "https:";
  if (!AUDIO_HOSTS.some((re) => re.test(url.hostname))) return fail(404, "This sound isn't available.", cors);
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const length = Number(upstream.headers.get("content-length") ?? 0);
    if (!upstream.ok || !upstream.body || length > MAX_AUDIO_BYTES) return fail(404, "This sound isn't available.", cors);
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "public, max-age=604800",
        ...(length > 0 ? { "Content-Length": String(length) } : {}),
        ...cors,
      },
    });
  } catch {
    return fail(502, OFFLINE, cors);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const name = url.pathname.split("/").filter(Boolean).pop() ?? "";
    if (name === "audio") return audio(url.searchParams.get("url"), cors);
    return tunnel(request, name, cors);
  },
};
