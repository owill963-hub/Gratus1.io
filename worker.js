/**
 * Gratus1.io — Hybrid Worker: static assets + Meta Conversions API relay
 *   + private gate for the daily dashboard
 * Pixel: 503178326149166 | Endpoint: POST /capi
 * Token: wrangler secret META_CAPI_TOKEN (endpoint returns 503 until set)
 * Dashboard key: wrangler secret DASHBOARD_KEY (gate returns 503 until set)
 * Dashboard: clean URL /status-board  →  serves "Daily Dashboard.html"
 *            first visit /status-board?key=YOUR_SECRET  sets a 1yr cookie
 */
const PIXEL_ID = "503178326149166";
const GRAPH_VERSION = "v21.0";
const ALLOWED_HOST_SUFFIX = "gratus1.io";

// Clean-URL → asset filename
const PAGE_ROUTES = {
  "/": "/Gratus1 Nebula.dc.html",
  "/home": "/Gratus1 Home.dc.html",
  "/my-tech-buddy": "/My Tech Buddy.dc.html",
  "/tactical-vibes": "/Tactical Vibes.dc.html",
  "/status-board": "/Daily Dashboard.html",
};

// Private paths — only reachable with the access key / auth cookie.
// Gate both the clean route AND the raw filename so the file can't be
// reached directly, un-gated.
const PROTECTED = ["/status-board", "/status-board/board", "/Daily%20Dashboard.html",
                   "/feed.json", "/agents.json", "/agent-control"];
const DASH_COOKIE = "g1_dash";
const FEED_KEY = "feed:current";
// Agent heartbeats. Each scheduled agent posts here after a successful run, so
// the two independent schedulers — Cloudflare cron and GitHub Actions — can
// watch each other. A silent death is otherwise indistinguishable from a quiet
// night: the board would keep serving the last-good feed forever with no signal.
// (the KV blob is now HEARTBEAT_LEGACY; env.HEARTBEAT_KEY is the bearer secret —
//  same name, different thing, so the constant is gone to avoid the confusion)
// Per-agent keys, not one blob. Three writers — the nightly job, the monitor
// worker and this worker's own cron — were doing read-modify-write on a single
// KV key, and KV is eventually consistent: each writer read a stale copy and
// wrote back, silently dropping the others. It showed up in production as an
// agent with a last run but no history, beside one with history but no last
// run. Separate keys mean writers never contend.
const beatKey = (a) => `agents:beat:${a}`;
const histKey = (a) => `agents:hist:${a}`;
const HISTORY_KEY = "agents:history";     // legacy blob, read for migration only
const HEARTBEAT_LEGACY = "agents:heartbeats";
const CONTROL_KEY = "agents:controls";    // pause / acknowledge state (single writer: the panel)
const HISTORY_DAYS = 7;
const HISTORY_MAX = 200;                  // per agent, whichever bound hits first
const PAUSE_MAX_MS = 4 * 3600 * 1000;     // a pause is a deliberate outage: it expires
const HEARTBEAT_STALE_MIN = { "nightly-ops": 26 * 60, "postiz-monitor": 90 }; // KV key holding the live status-board feed

// Legacy pages → their new canonical URLs (301 so search engines transfer rank)
const LEGACY_REDIRECTS = {
  "/index.html": "/",
  "/nebula": "/", // Nebula lives at / — collapse the alias
  "/Gratus1.html": "/", // headless pre-launch fragment — no <head>/canonical
  "/mytechbuddy.html": "/my-tech-buddy",
  "/tacticalvibes.html": "/tactical-vibes",
};

// Apple App Site Association — App Clip + universal links for Tactical Vibes.
// Served inline (not from the asset bucket) so it is always application/json, never redirected,
// and never subject to the .well-known handling of the static layer.
const TV_TEAM_APP_ID = "RKTX4UNR7Y.io.gratus1.tacticalvibes";
const AASA = {
  appclips: { apps: [TV_TEAM_APP_ID + ".Clip"] },
  applinks: { details: [{ appIDs: [TV_TEAM_APP_ID], components: [{ "/": "/clip/*" }] }] },
};
const TV_APP_STORE_URL = "https://apps.apple.com/us/app/tactical-vibes/id6776399589";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/capi" && request.method === "POST") {
      return handleCapi(request, env);
    }

    if (url.pathname === "/.well-known/apple-app-site-association" || url.pathname === "/apple-app-site-association") {
      return new Response(JSON.stringify(AASA), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
      });
    }

    // App Clip invocation URLs. iOS intercepts these before they reach us; anything that does
    // arrive is a non-iOS client (or an iPhone without the clip) → send it to the App Store listing.
    if (url.pathname === "/clip" || url.pathname.startsWith("/clip/")) {
      return Response.redirect(TV_APP_STORE_URL, 302);
    }

    // Normalize optional trailing slash (but keep "/" itself)
    const cleanPath = url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

    // Agent heartbeat intake. Deliberately its own bearer secret rather than the
    // dashboard cookie gate: this is called by CI, not by a browser.
    if (cleanPath === "/agent-heartbeat") {
      return agentHeartbeat(request, env);
    }

    // Private dashboard gate: returns a Response to block/redirect, or null to allow
    // (checked against the normalized path so "/status-board/" can't bypass it)
    if (PROTECTED.includes(cleanPath)) {
      const gate = await guardDashboard(request, env, url);
      if (gate) return gate;
    }

    // The board itself, for the shell's iframe.
    if (cleanPath === "/status-board/board") {
      const boardUrl = new URL(request.url);
      boardUrl.pathname = PAGE_ROUTES["/status-board"];
      boardUrl.search = "";
      return env.ASSETS.fetch(new Request(boardUrl, request));
    }

    // Agent control panel data and actions. Both sit behind the dashboard gate
    // above — same session, no second credential to carry on a phone.
    if (cleanPath === "/agents.json") return agentsPanel(request, env);
    if (cleanPath === "/agent-control") return agentControl(request, env);

    // Serve the live status-board feed from KV (static feed.json is the seed/fallback).
    // Gate above has already authenticated the request for this path.
    if (cleanPath === "/feed.json") {
      return serveFeed(request, env, url, ctx);
    }

    // Legacy page redirects → new canonical URLs
    if (LEGACY_REDIRECTS[cleanPath]) {
      return Response.redirect(new URL(LEGACY_REDIRECTS[cleanPath] + url.search, url.origin), 301);
    }

    // The status board is a self-extracting design bundle: on load its script
    // rebuilds the whole document from blob: URLs, so anything injected into the
    // served HTML is discarded before it runs. Verified — an injected panel was
    // absent from documentElement.outerHTML entirely. So the panel is not
    // injected into it; the board is framed instead, which isolates the bundle
    // and leaves the panel in a document the bundle cannot touch.
    if (cleanPath === "/status-board") {
      return new Response(statusBoardShell(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Clean-URL rewrite (runs only after the gate has passed)
    if (PAGE_ROUTES[cleanPath]) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = PAGE_ROUTES[cleanPath];
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Redirect direct hits on the raw .dc.html filenames to their clean URLs
    // (skip protected assets — the gate above already handles those paths)
    const decodedPath = decodeURIComponent(url.pathname);
    for (const [clean, asset] of Object.entries(PAGE_ROUTES)) {
      if (clean === "/" || clean === "/status-board") continue;
      // Match both the raw filename and its extension-stripped ".dc" form
      if (decodedPath === asset || decodedPath === asset.replace(/\.html$/, "")) {
        return Response.redirect(new URL(clean + url.search, url.origin), 301);
      }
    }
    // Raw Nebula filename → root
    if (decodedPath === "/Gratus1 Nebula.dc.html" || decodedPath === "/Gratus1 Nebula.dc") {
      return Response.redirect(new URL("/" + url.search, url.origin), 301);
    }

    return env.ASSETS.fetch(request);
  },

  // Cron (*/30 * * * *) — regenerate the feed and cache it in KV, unless this
  // agent is paused from the control panel. Records its own heartbeat locally;
  // no HTTP round-trip needed for an agent living in this worker.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (await isPaused("gratus1-feed", env)) {
        await recordBeat("gratus1-feed", "paused", "skipped: paused from control panel", env);
        return;
      }
      const feed = await refreshFeed(env);
      await recordBeat("gratus1-feed", feed ? "ok" : "failed",
                       feed ? "feed rebuilt" : "refresh returned null", env);
    })());
  },
};

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function guardDashboard(request, env, url) {
  if (!env.DASHBOARD_KEY) {
    return new Response("Dashboard access key not configured.", { status: 503 });
  }
  const token = await sha256Hex(env.DASHBOARD_KEY);
  const cookies = parseCookies(request.headers.get("cookie") || "");

  // Already authenticated via cookie
  if (cookies[DASH_COOKIE] === token) return null;

  // Magic-link login: visit /status-board?key=YOUR_SECRET once
  if (url.searchParams.get("key") === env.DASHBOARD_KEY) {
    return new Response(null, {
      status: 302,
      headers: {
        location: url.pathname, // strip ?key from the address bar
        "set-cookie": `${DASH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
      },
    });
  }

  return new Response("401 — Private. Access denied.", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function handleCapi(request, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    });

  // Same-site guard first: only accept events originating from gratus1.io
  const origin = request.headers.get("origin") || "";
  const referer = request.headers.get("referer") || "";
  const fromSite = (v) => {
    try { return new URL(v).hostname.endsWith(ALLOWED_HOST_SUFFIX); }
    catch { return false; }
  };
  if (!fromSite(origin) && !fromSite(referer)) {
    return json({ ok: false, error: "forbidden_origin" }, 403);
  }

  if (!env.META_CAPI_TOKEN) {
    return json({ ok: false, error: "capi_not_configured" }, 503);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }

  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const cookies = parseCookies(request.headers.get("cookie") || "");

  const event = {
    event_name: str(body.event_name, 50) || "PageView",
    event_time: Math.floor(Date.now() / 1000),
    event_id: str(body.event_id, 64) || crypto.randomUUID(),
    action_source: "website",
    event_source_url: str(body.event_source_url, 2048) || referer || "https://gratus1.io/",
    user_data: {
      client_ip_address: request.headers.get("cf-connecting-ip") || undefined,
      client_user_agent: request.headers.get("user-agent") || undefined,
      fbp: str(body.fbp, 128) || cookies["_fbp"] || undefined,
      fbc: str(body.fbc, 256) || cookies["_fbc"] || undefined,
    },
  };
  if (body.custom_data && typeof body.custom_data === "object") {
    event.custom_data = body.custom_data;
  }

  const payload = { data: [event] };
  const testCode = str(body.test_event_code, 32);
  if (testCode) payload.test_event_code = testCode;

  const resp = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.log("CAPI_ERROR", JSON.stringify({status: resp.status, error: result.error && {message: result.error.message, type: result.error.type, code: result.error.code, subcode: result.error.error_subcode}}));
  }
  return json(
    { ok: resp.ok, events_received: result.events_received, fbtrace_id: result.fbtrace_id },
    resp.ok ? 200 : 502
  );
}


/* ───────────────────────── Status-board feed engine ─────────────────────────
 * /feed.json is served from KV (key "feed:current"), refreshed by cron every
 * 30 min. The static feed.json asset is the seed / fallback so the board never
 * blanks out. Each source updates its own slice only when its secret is set —
 * missing secrets leave the last-good slice untouched.
 * ─────────────────────────────────────────────────────────────────────────── */

async function serveFeed(request, env, url, ctx) {
  const jsonResp = (obj) =>
    new Response(JSON.stringify(obj), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });

  // Authenticated on-demand rebuild: /feed.json?refresh=1
  if (url.searchParams.get("refresh") === "1") {
    const feed = await refreshFeed(env);
    if (feed) return jsonResp(feed);
  }

  // Normal path: serve cached KV feed
  if (env.FEED_KV) {
    const cached = await env.FEED_KV.get(FEED_KEY);
    if (cached) {
      return new Response(cached, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
  }

  // Fallback: static seed file shipped in the repo
  const seedUrl = new URL(request.url);
  seedUrl.pathname = "/feed.json";
  seedUrl.search = "";
  return env.ASSETS.fetch(new Request(seedUrl, { headers: request.headers }));
}

async function refreshFeed(env) {
  try {
    const feed = await buildFeed(env);
    if (env.FEED_KV) {
      await env.FEED_KV.put(FEED_KEY, JSON.stringify(feed));
    }
    return feed;
  } catch (err) {
    console.log("FEED_REFRESH_ERROR", String(err && err.message || err));
    return null;
  }
}

async function buildFeed(env) {
  // Start from last-good (KV) or the static seed so no slice ever blanks out.
  let base = await readKvJson(env, FEED_KEY);
  if (!base) base = await readSeed(env);
  const feed = base && typeof base === "object"
    ? JSON.parse(JSON.stringify(base))
    : { owner: "Oliver", greeting: "", intention: "", kpis: [], sections: [] };

  feed.generatedAt = new Date().toISOString();
  feed.owner = feed.owner || "Oliver";
  if (!Array.isArray(feed.kpis)) feed.kpis = [];
  if (!Array.isArray(feed.sections)) feed.sections = [];

  // Each fetcher mutates its own slice; failures are isolated.
  await Promise.allSettled([
    updatePostiz(feed, env),
    updateGitHub(feed, env),
  ]);

  return feed;
}

async function readKvJson(env, key) {
  if (!env.FEED_KV) return null;
  try {
    const raw = await env.FEED_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function readSeed(env) {
  try {
    const resp = await env.ASSETS.fetch(new Request("https://gratus1.io/feed.json"));
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// Replace the items (and optionally title/source) of an existing section by key.
// Never creates a section — leaves the seed layout authoritative.
function setSection(feed, key, patch) {
  const sec = feed.sections.find((s) => s.key === key);
  if (!sec) return;
  if (patch.title) sec.title = patch.title;
  if (patch.source) sec.source = patch.source;
  if (Array.isArray(patch.items) && patch.items.length) sec.items = patch.items;
}

// ── Postiz → "social" section ────────────────────────────────────────────────
async function updatePostiz(feed, env) {
  // A slice that cannot refresh must say so. Returning quietly here is what let
  // the board present seed data as though it were live: the secret was never
  // set on this worker, so this branch had been taken on every cron run since
  // the feed shipped, and nothing on the page or in the JSON gave that away.
  if (!env.POSTIZ_API_KEY) {
    setSection(feed, "social", {
      source: "Postiz · NOT LIVE",
      items: [{
        title: "Social slice is not refreshing",
        meta: "POSTIZ_API_KEY is not set on this worker — figures below are seed data",
        pill: "#e05b5b",
      }],
    });
    return;
  }
  const base = env.POSTIZ_API_BASE || "https://api.postiz.com/public/v1";
  const now = new Date();
  const start = now.toISOString().slice(0, 19) + "Z";
  const end = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 19) + "Z";

  const res = await fetch(`${base}/posts?startDate=${start}&endDate=${end}&limit=200`, {
    headers: { Authorization: env.POSTIZ_API_KEY, "content-type": "application/json" },
  });
  if (!res.ok) {
    // Same principle on a failed fetch: 401 after a token rotation, or 429 from
    // the shared quota, must be visible rather than leaving yesterday's numbers
    // in place looking current.
    setSection(feed, "social", {
      source: "Postiz · STALE",
      items: [{
        title: `Postiz refresh failed (HTTP ${res.status})`,
        meta: res.status === 429
          ? "Shared rate limit exhausted — another consumer burned the quota"
          : "Figures below are the last good values, not current",
        pill: "#e05b5b",
      }],
    });
    return;
  }
  const body = await res.json();
  const posts = Array.isArray(body) ? body : (body.data || body.posts || []);

  const queued = posts.filter((p) => p.state && p.state !== "PUBLISHED" && p.state !== "ERROR");
  const errors = posts.filter((p) => p.state === "ERROR");
  const plat = (p) => (p.integration?.providerIdentifier || p.provider || "").toLowerCase();
  const platforms = [...new Set(queued.map(plat).filter(Boolean))];
  const label = (s) => s.replace(/^\w/, (c) => c.toUpperCase());

  const items = [];
  if (queued.length) {
    items.push({
      title: `${queued.length} post${queued.length === 1 ? "" : "s"} scheduled${platforms.length ? " — " + platforms.map(label).join(" / ") : ""}`,
      meta: "Next 7 days · queued",
      pill: "#6fcf7a",
    });
  }
  if (errors.length) {
    items.push({
      title: `${errors.length} post${errors.length === 1 ? "" : "s"} in ERROR state`,
      meta: "Needs attention · auto-monitor active",
      pill: "#e05b5b",
    });
  }
  if (!items.length) {
    items.push({ title: "No posts scheduled in the next 7 days", meta: "Queue empty", pill: "#e0b968" });
  }
  setSection(feed, "social", { source: "Postiz · live", items });
}

// ── GitHub open issues → "todo" + "ticket" sections ──────────────────────────
async function updateGitHub(feed, env) {
  if (!env.GH_TOKEN) return; // secret absent → leave last-good slice
  const repo = env.GH_REPO || "owill963-hub/Gratus1_Collab";
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=50&sort=updated`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "gratus1-status-board",
      },
    }
  );
  if (!res.ok) throw new Error("github " + res.status);
  const all = await res.json();
  // Drop PRs (they surface on the issues endpoint too)
  const issues = (Array.isArray(all) ? all : []).filter((i) => !i.pull_request);

  const labelsOf = (i) => (i.labels || []).map((l) => (l.name || "").toLowerCase());
  const isBlocker = (i) =>
    labelsOf(i).some((n) => /blocker|bug|security|incident|ticket/.test(n));

  const pillFor = (i) => {
    const l = labelsOf(i);
    if (l.some((n) => /high|urgent|critical|security/.test(n))) return "#e05b5b";
    if (l.some((n) => /medium|review/.test(n))) return "#e0b968";
    return "#c7820e";
  };
  const toItem = (i) => ({
    title: i.title,
    meta: `#${i.number} · ${labelsOf(i).join(", ") || "no label"} · ${i.comments} comment${i.comments === 1 ? "" : "s"}`,
    pill: pillFor(i),
  });

  const tickets = issues.filter(isBlocker).slice(0, 6).map(toItem);
  const todos = issues.filter((i) => !isBlocker(i)).slice(0, 6).map(toItem);

  if (todos.length) setSection(feed, "todo", { source: "GitHub · live", items: todos });
  if (tickets.length) setSection(feed, "ticket", { source: "GitHub · live", items: tickets });
}

// ── Agent heartbeats ─────────────────────────────────────────────────────────
// POST /agent-heartbeat  {agent, status, detail}   Authorization: Bearer <key>
// Returns the age of the feed alongside every recorded heartbeat, so the caller
// can check the other scheduler in the same round-trip it uses to report itself.
async function agentHeartbeat(request, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (!env.HEARTBEAT_KEY) return json({ error: "heartbeat key not configured" }, 503);
  const auth = request.headers.get("authorization") || "";
  const presented = auth.replace(/^Bearer\s+/i, "");
  // Constant-time-ish: compare digests, not the raw strings.
  const ok = presented &&
    (await sha256Hex(presented)) === (await sha256Hex(env.HEARTBEAT_KEY));
  if (!ok) return json({ error: "unauthorized" }, 401);

  const beats = {};
  for (const name of Object.keys(HEARTBEAT_STALE_MIN)) {
    beats[name] = (await readKvJson(env, beatKey(name)))
      || ((await readKvJson(env, HEARTBEAT_LEGACY)) || {})[name] || null;
  }

  if (request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* tolerate an empty ping */ }
    const agent = String(body.agent || "").slice(0, 40);
    if (!agent) return json({ error: "agent is required" }, 400);
    await recordBeat(agent,
      String(body.status || "ok").slice(0, 20),
      String(body.detail || "").slice(0, 300), env);
    beats[agent] = await readKvJson(env, beatKey(agent));
  }

  const feed = await readKvJson(env, FEED_KEY);
  const feedAt = feed && feed.generatedAt ? Date.parse(feed.generatedAt) : null;
  const ctrl = (await readKvJson(env, CONTROL_KEY)) || {};
  const paused = {};
  for (const [name, c] of Object.entries(ctrl)) {
    if (c && c.paused_until && Date.parse(c.paused_until) > Date.now()) {
      paused[name] = c.paused_until;
    }
  }
  return json({
    ok: true,
    paused,
    feed_generated_at: feed && feed.generatedAt ? feed.generatedAt : null,
    feed_age_minutes: feedAt ? Math.round((Date.now() - feedAt) / 60000) : null,
    heartbeats: beats,
    stale: staleAgents(beats),
  });
}

// Which agents have missed their window. Threshold per agent, because a 30-min
// cron and a nightly job fail on very different timescales.
function staleAgents(beats) {
  const out = [];
  for (const [agent, limit] of Object.entries(HEARTBEAT_STALE_MIN)) {
    const b = beats && beats[agent];
    if (!b) { out.push({ agent, age_minutes: null, reason: "never reported" }); continue; }
    const age = Math.round((Date.now() - Date.parse(b.at)) / 60000);
    if (age > limit) out.push({ agent, age_minutes: age, limit_minutes: limit, reason: "overdue" });
    else if (b.status && b.status !== "ok") out.push({ agent, age_minutes: age, reason: `last run ${b.status}` });
  }
  return out;
}

// ── Agent control panel ──────────────────────────────────────────────────────
const AGENT_LABELS = {
  "nightly-ops": "Nightly ops (GitHub Actions, 02:00Z)",
  "postiz-monitor": "Postiz monitor (Worker, every 30 min)",
  "gratus1-feed": "Status-board feed (Worker, every 30 min)",
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// An acknowledgement is bound to the state it was made against, so it clears
// itself the moment something different goes wrong rather than muting the next
// real incident.
function alertSignature(beat) {
  if (!beat) return "none";
  return `${beat.status}|${(beat.detail || "").slice(0, 120)}`;
}

async function readAgent(agent, env) {
  // Prefer the per-agent keys; fall back to the legacy blobs so the panel keeps
  // working for agents that have not reported since the split.
  const beat = (await readKvJson(env, beatKey(agent)))
    || ((await readKvJson(env, HEARTBEAT_LEGACY)) || {})[agent] || null;
  const runs = (await readKvJson(env, histKey(agent)))
    || ((await readKvJson(env, HISTORY_KEY)) || {})[agent] || [];
  return { beat, runs };
}

async function panelState(env) {
  const ctrl = (await readKvJson(env, CONTROL_KEY)) || {};
  const loaded = {};
  for (const name of Object.keys(AGENT_LABELS)) loaded[name] = await readAgent(name, env);
  const now = Date.now();
  const day = now - 86400000;

  const agents = Object.keys(AGENT_LABELS).map((name) => {
    const beat = loaded[name].beat;
    const runs = loaded[name].runs;
    const lastSuccess = runs.find((r) => r.status === "ok") || null;
    const c = ctrl[name] || {};
    const pausedUntil = c.paused_until && Date.parse(c.paused_until) > now ? c.paused_until : null;
    const sig = alertSignature(beat);
    const acked = c.ack && c.ack.sig === sig;
    const limit = HEARTBEAT_STALE_MIN[name];
    const ageMin = beat ? Math.round((now - Date.parse(beat.at)) / 60000) : null;
    const overdue = limit != null && (ageMin == null || ageMin > limit);

    return {
      agent: name,
      label: AGENT_LABELS[name],
      last_run: beat ? beat.at : null,
      last_run_status: beat ? beat.status : null,
      last_run_detail: beat ? beat.detail : "",
      last_run_age_min: ageMin,
      last_success: lastSuccess ? lastSuccess.at : null,
      errors_24h: runs.filter((r) => r.status !== "ok" && Date.parse(r.at) > day).length,
      errors_7d: runs.filter((r) => r.status !== "ok").length,
      runs_7d: runs.length,
      stale_limit_min: limit ?? null,
      overdue,
      paused_until: pausedUntil,
      acknowledged: !!acked,
      // Healthy means: reported recently, last run ok, not paused.
      // Coerce: `beat &&` yields null when there is no beat, and the panel then
      // renders neither healthy nor unhealthy.
      healthy: !!(!overdue && beat && beat.status === "ok" && !pausedUntil),
    };
  });

  return { generated_at: new Date().toISOString(), pause_max_hours: PAUSE_MAX_MS / 3600000, agents };
}

async function agentsPanel(request, env) {
  return jsonResp(await panelState(env));
}

async function agentControl(request, env) {
  if (request.method !== "POST") return jsonResp({ error: "POST required" }, 405);
  let body = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const agent = String(body.agent || "");
  const action = String(body.action || "");
  if (!AGENT_LABELS[agent]) return jsonResp({ error: "unknown agent" }, 400);

  // Typed confirmation: the caller must echo the agent name. Cheap, and it stops
  // a mis-tap on a phone pausing the nightly or spending Postiz quota.
  if (String(body.confirm || "") !== agent) {
    return jsonResp({ error: `confirm must equal "${agent}"` }, 400);
  }

  const ctrl = (await readKvJson(env, CONTROL_KEY)) || {};
  const cur = ctrl[agent] || {};

  if (action === "pause") {
    // Clamped, never open-ended. A forgotten pause is a silent outage.
    const hours = Math.min(Number(body.hours) || 4, PAUSE_MAX_MS / 3600000);
    cur.paused_until = new Date(Date.now() + hours * 3600000).toISOString();
  } else if (action === "resume") {
    cur.paused_until = null;
  } else if (action === "ack") {
    const beats = {};
  for (const name of Object.keys(HEARTBEAT_STALE_MIN)) {
    beats[name] = (await readKvJson(env, beatKey(name)))
      || ((await readKvJson(env, HEARTBEAT_LEGACY)) || {})[name] || null;
  }
    cur.ack = { sig: alertSignature(beats[agent]), at: new Date().toISOString() };
  } else if (action === "rerun") {
    const out = await rerunAgent(agent, env);
    return jsonResp({ ok: out.ok, action, agent, detail: out.detail });
  } else {
    return jsonResp({ error: "action must be pause, resume, ack or rerun" }, 400);
  }

  ctrl[agent] = cur;
  if (env.FEED_KV) await env.FEED_KV.put(CONTROL_KEY, JSON.stringify(ctrl));
  return jsonResp({ ok: true, action, agent, state: cur });
}

async function rerunAgent(agent, env) {
  if (agent === "gratus1-feed") {
    const feed = await refreshFeed(env);
    return { ok: !!feed, detail: feed ? "feed rebuilt" : "refresh failed" };
  }
  if (agent === "postiz-monitor") {
    if (!env.MONITOR_URL || !env.MONITOR_TOKEN) {
      return { ok: false, detail: "MONITOR_URL / MONITOR_TOKEN not configured on this worker" };
    }
    try {
      const r = await fetch(`${env.MONITOR_URL}/run`, {
        headers: { Authorization: `Bearer ${env.MONITOR_TOKEN}` },
      });
      return { ok: r.ok, detail: `monitor responded ${r.status}` };
    } catch (e) {
      return { ok: false, detail: String((e && e.message) || e) };
    }
  }
  if (agent === "nightly-ops") {
    // Triggering a GitHub Actions workflow needs a repo-scoped token this worker
    // does not hold. Say so plainly rather than pretending the button worked.
    return { ok: false, detail: "not wired: needs a GitHub token with workflow scope" };
  }
  return { ok: false, detail: "no rerun path for this agent" };
}

// Shared by the in-worker agent and the /agent-heartbeat intake.
async function isPaused(agent, env) {
  const ctrl = (await readKvJson(env, CONTROL_KEY)) || {};
  const until = ctrl[agent] && ctrl[agent].paused_until;
  return !!(until && Date.parse(until) > Date.now());
}

async function recordBeat(agent, status, detail, env) {
  if (!env.FEED_KV) return;
  const entry = { at: new Date().toISOString(), status, detail: String(detail).slice(0, 300) };
  // Only this agent's own keys are touched, so concurrent agents cannot clobber
  // one another the way they did with a shared blob.
  const prior = (await readKvJson(env, histKey(agent)))
    || ((await readKvJson(env, HISTORY_KEY)) || {})[agent] || [];
  const cutoff = Date.now() - HISTORY_DAYS * 86400000;
  const runs = [entry, ...prior].filter((r) => Date.parse(r.at) > cutoff).slice(0, HISTORY_MAX);
  await env.FEED_KV.put(beatKey(agent), JSON.stringify(entry));
  await env.FEED_KV.put(histKey(agent), JSON.stringify(runs));
}

// ── Control panel markup, injected into /status-board ────────────────────────
function statusBoardShell() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Status board</title>' +
    '<style>html,body{margin:0;background:#0b0912;}' +
    'iframe{display:block;width:100%;height:100vh;border:0;}</style>' +
    '</head><body>' + AGENT_PANEL_BOOT +
    '<iframe src="/status-board/board" title="Daily dashboard" loading="eager"></iframe>' +
    '</body></html>';
}


const AGENT_PANEL_BOOT = `
<script>
(function(){
  var MARKUP =
    '<section id="agent-panel" style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;' +
    'max-width:1100px;margin:32px auto 56px;padding:20px;color:#e8e6f0;background:#12101c;' +
    'border:1px solid rgba(255,255,255,.12);border-radius:14px;">' +
      '<h2 style="font-size:17px;margin:0 0 4px;">Agents</h2>' +
      '<p id="ap-sub" style="margin:0 0 16px;font-size:13px;opacity:.6;">loading…</p>' +
      '<div id="ap-rows" style="display:grid;gap:10px;"></div>' +
    '</section>';

  function ago(iso){ if(!iso) return 'never';
    var m=Math.round((Date.now()-Date.parse(iso))/60000);
    if(m<60) return m+'m ago'; var h=Math.round(m/60);
    return h<48 ? h+'h ago' : Math.round(h/24)+'d ago'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function btn(agent,action,label){
    return '<button data-agent="'+esc(agent)+'" data-action="'+action+'" '+
      'style="font:inherit;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;'+
      'border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e8e6f0;">'+label+'</button>';
  }
  function card(a){
    var colour = a.paused_until ? '#e0b968' : (a.healthy ? '#6fcf7a' : '#e05b5b');
    var state  = a.paused_until ? 'PAUSED until '+new Date(a.paused_until).toLocaleTimeString()
               : (a.healthy ? 'healthy' : (a.overdue ? 'OVERDUE' : 'last run '+esc(a.last_run_status)));
    return '<div style="border:1px solid rgba(255,255,255,.12);border-left:3px solid '+colour+
      ';border-radius:10px;padding:14px 16px;background:rgba(255,255,255,.03);">'+
      '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;">'+
        '<strong style="font-size:14px;">'+esc(a.label)+'</strong>'+
        '<span style="font-size:12px;color:'+colour+';font-weight:600;">'+esc(state)+
        (a.acknowledged?' · acknowledged':'')+'</span></div>'+
      '<div style="margin-top:8px;font-size:12px;opacity:.75;display:flex;gap:18px;flex-wrap:wrap;">'+
        '<span>last run '+ago(a.last_run)+'</span>'+
        '<span>last success '+ago(a.last_success)+'</span>'+
        '<span>errors 24h <b>'+a.errors_24h+'</b></span>'+
        '<span>errors 7d <b>'+a.errors_7d+'</b></span>'+
        '<span>'+a.runs_7d+' runs/7d</span></div>'+
      (a.last_run_detail?'<div style="margin-top:6px;font-size:12px;opacity:.55;">'+esc(a.last_run_detail)+'</div>':'')+
      '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">'+
        btn(a.agent,'rerun','Re-run')+
        (a.paused_until?btn(a.agent,'resume','Resume'):btn(a.agent,'pause','Pause 4h'))+
        (a.healthy?'':btn(a.agent,'ack','Acknowledge'))+
      '</div></div>';
  }
  function load(){
    var R=document.getElementById('ap-rows'), S=document.getElementById('ap-sub');
    if(!R) return;
    fetch('/agents.json',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(d){
      R.innerHTML = d.agents.map(card).join('');
      var bad = d.agents.filter(function(a){return !a.healthy && !a.paused_until;}).length;
      S.textContent = (bad ? bad+' agent'+(bad>1?'s need':' needs')+' attention' : 'All agents healthy')+
        ' · pauses expire after '+d.pause_max_hours+'h';
    }).catch(function(e){ S.textContent='could not load agent state: '+e; });
  }
  function onClick(ev){
    var b=ev.target.closest && ev.target.closest('button[data-agent]'); if(!b) return;
    var agent=b.dataset.agent, action=b.dataset.action;
    var typed=prompt('Type the agent name to '+action+':' + String.fromCharCode(10,10) + agent);
    if(typed!==agent){ if(typed!==null) alert('Name did not match — nothing changed.'); return; }
    b.disabled=true; b.textContent='…';
    fetch('/agent-control',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({agent:agent,action:action,confirm:agent})})
      .then(function(r){return r.json();})
      .then(function(d){ if(d.error||d.ok===false) alert(action+' failed: '+(d.error||d.detail)); load(); })
      .catch(function(e){ alert(action+' failed: '+e); load(); });
  }
  function attach(){
    if(document.getElementById('agent-panel')) return;
    if(!document.body) return;
    var host=document.createElement('div');
    host.innerHTML=MARKUP;
    var node=host.firstChild;
    document.body.insertBefore(node, document.body.firstChild);
    node.addEventListener('click', onClick);
    load();
  }
  // The shell is a plain document we control, so one attach is enough.
  if(document.readyState!=='loading') attach();
  else document.addEventListener('DOMContentLoaded', attach);
  setInterval(load, 60000);
})();
</script>`;

