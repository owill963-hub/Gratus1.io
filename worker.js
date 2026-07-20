/**
 * Gratus1.io — Hybrid Worker: static assets + Meta Conversions API relay
 *   + private gate for the daily review dashboard
 *   + clean-URL routes for the .dc.html pages
 *   + Nebula redesign is the canonical homepage (served at /)
 * Pixel: 1356026399874586 | Endpoint: POST /capi
 * Token: wrangler secret META_CAPI_TOKEN (endpoint returns 503 until set)
 * Dashboard key: wrangler secret DASHBOARD_KEY (gate returns 503 until set)
 */
const PIXEL_ID = "1356026399874586";
const GRAPH_VERSION = "v21.0";
const ALLOWED_HOST_SUFFIX = "gratus1.io";

// Private paths — only reachable with the access key / auth cookie
const PROTECTED = ["/gratus1-dashboard.html", "/feed.json"];
const DASH_COOKIE = "g1_dash";

// Clean URLs → asset files (Nebula redesign pages)
const PAGE_ROUTES = {
  "/": "/Gratus1 Nebula.dc.html",          // Nebula IS the homepage
  "/home": "/Gratus1 Home.dc.html",
  "/nebula": "/Gratus1 Nebula.dc.html",
  "/my-tech-buddy": "/My Tech Buddy.dc.html",
  "/tactical-vibes": "/Tactical Vibes.dc.html",
};

// Legacy pages → their new canonical URLs (301 so search engines transfer rank)
const LEGACY_REDIRECTS = {
  "/index.html": "/",
  "/mytechbuddy.html": "/my-tech-buddy",
  "/tacticalvibes.html": "/tactical-vibes",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/capi" && request.method === "POST") {
      return handleCapi(request, env);
    }

    // Private dashboard gate: returns a Response to block/redirect, or null to allow
    if (PROTECTED.includes(url.pathname)) {
      const gate = await guardDashboard(request, env, url);
      if (gate) return gate;
    }

    // Normalize optional trailing slash (but keep "/" itself)
    const cleanPath = url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

    // Legacy page redirects → new canonical URLs
    if (LEGACY_REDIRECTS[cleanPath]) {
      return Response.redirect(new URL(LEGACY_REDIRECTS[cleanPath] + url.search, url.origin), 301);
    }

    // Clean-URL rewrites for the Nebula pages
    if (PAGE_ROUTES[cleanPath]) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = PAGE_ROUTES[cleanPath];
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Redirect direct hits on the raw .dc.html filenames to their clean URLs
    const decodedPath = decodeURIComponent(url.pathname);
    for (const [clean, asset] of Object.entries(PAGE_ROUTES)) {
      if (clean !== "/" && decodedPath === asset) {
        return Response.redirect(new URL(clean + url.search, url.origin), 301);
      }
    }
    // Raw Nebula filename → root
    if (decodedPath === "/Gratus1 Nebula.dc.html") {
      return Response.redirect(new URL("/" + url.search, url.origin), 301);
    }

    return env.ASSETS.fetch(request);
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

  // Magic-link login: visit /gratus1-dashboard.html?key=YOUR_SECRET once
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
