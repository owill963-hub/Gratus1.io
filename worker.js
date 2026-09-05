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
const PROTECTED = ["/status-board", "/Daily%20Dashboard.html", "/feed.json"];
const DASH_COOKIE = "g1_dash";
const FEED_KEY = "feed:current";
// Agent heartbeats. Each scheduled agent posts here after a successful run, so
// the two independent schedulers — Cloudflare cron and GitHub Actions — can
// watch each other. A silent death is otherwise indistinguishable from a quiet
// night: the board would keep serving the last-good feed forever with no signal.
const HEARTBEAT_KEY = "agents:heartbeats";
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

    // Serve the live status-board feed from KV (static feed.json is the seed/fallback).
    // Gate above has already authenticated the request for this path.
    if (cleanPath === "/feed.json") {
      return serveFeed(request, env, url, ctx);
    }

    // Legacy page redirects → new canonical URLs
    if (LEGACY_REDIRECTS[cleanPath]) {
      return Response.redirect(new URL(LEGACY_REDIRECTS[cleanPath] + url.search, url.origin), 301);
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

  // Cron (*/30 * * * *) — regenerate the feed and cache it in KV.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshFeed(env));
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
  if (!env.POSTIZ_API_KEY) return; // secret absent → leave last-good slice
  const base = env.POSTIZ_API_BASE || "https://api.postiz.com/public/v1";
  const now = new Date();
  const start = now.toISOString().slice(0, 19) + "Z";
  const end = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 19) + "Z";

  const res = await fetch(`${base}/posts?startDate=${start}&endDate=${end}&limit=200`, {
    headers: { Authorization: env.POSTIZ_API_KEY, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error("postiz " + res.status);
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

  const beats = (await readKvJson(env, HEARTBEAT_KEY)) || {};

  if (request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* tolerate an empty ping */ }
    const agent = String(body.agent || "").slice(0, 40);
    if (!agent) return json({ error: "agent is required" }, 400);
    beats[agent] = {
      at: new Date().toISOString(),
      status: String(body.status || "ok").slice(0, 20),
      detail: String(body.detail || "").slice(0, 300),
    };
    if (env.FEED_KV) await env.FEED_KV.put(HEARTBEAT_KEY, JSON.stringify(beats));
  }

  const feed = await readKvJson(env, FEED_KEY);
  const feedAt = feed && feed.generatedAt ? Date.parse(feed.generatedAt) : null;
  return json({
    ok: true,
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
