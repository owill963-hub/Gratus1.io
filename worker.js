/**
 * Gratus1.io — Hybrid Worker: static assets + Meta Conversions API relay
 * Pixel: 1356026399874586 | Endpoint: POST /capi
 * Token: wrangler secret META_CAPI_TOKEN (endpoint returns 503 until set)
 */
const PIXEL_ID = "1356026399874586";
const GRAPH_VERSION = "v21.0";
const ALLOWED_HOST_SUFFIX = "gratus1.io";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/capi" && request.method === "POST") {
      return handleCapi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

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
