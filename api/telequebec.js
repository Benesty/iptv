/**
 * Télé-Québec — résolveur du direct officiel + proxy HLS sécurisé.
 *
 * Chaîne de résolution (100 % API officielles Télé-Québec / Brightcove) :
 *   1. Beacon EPG   : beacon.playback.api.brightcove.com/telequebec/api/epg
 *                     -> contentId + streamId du direct courant
 *   2. Beacon asset : .../assets/{contentId}/streams/{streamId}
 *                     -> accountId Brightcove + videoId (ref/id)
 *   3. Player config: players.brightcove.net/{accountId}/default_default/config.json
 *                     -> policyKey publique du lecteur courant
 *   4. Playback API : edge.api.brightcove.com/playback/v1/accounts/{acc}/videos/{id}
 *                     -> liste des `sources`
 *   5. On ne retient QU'UNE source HLS publique NON chiffrée (pas de DRM).
 *      Si aucune source claire -> 409 explicite (aucun M3U classique possible).
 *
 * Sécurité du proxy (pas de proxy ouvert) :
 *   - aucun paramètre `?u=` arbitraire ; seules les URL réécrites par CETTE
 *     fonction, signées HMAC-SHA256 (secret TELEQUEBEC_PROXY_SECRET) et à
 *     expiration courte, sont acceptées (`?p=&e=&s=`) ;
 *   - HTTPS uniquement, hôtes restreints à une allowlist Brightcove/Akamai,
 *     refus des IP privées/loopback/link-local/métadonnées cloud ;
 *   - comparaison de signature à temps constant ;
 *   - si le secret n'est pas configuré, la diffusion est désactivée
 *     (le mode ?debug=1 reste disponible pour le diagnostic).
 *
 * Aucun DRM, jeton privé, licence ou restriction n'est contourné.
 */
export const config = { runtime: "edge", regions: ["yul1"] }; // Montréal

const API_ROOT = "https://beacon.playback.api.brightcove.com/telequebec/api";
const SITE_ORIGIN = "https://telequebec.tv";
const UA = "Mozilla/5.0 (SmartTV) AppleWebKit/537.36";
const SIGN_TTL = 90;            // s : durée de vie d'une URL de segment signée
const LIVE_MAX_AGE = 2;         // s : on ne cache pas la résolution du live

// Hôtes autorisés pour la proxification (défense en profondeur — la signature
// HMAC garantit déjà que seules NOS URL sont proxifiées).
const HOST_ALLOW = [
  ".akamaihd.net", ".akamaized.net",
  ".brightcove.com", ".brightcove.net",
  ".telequebec.tv",
  ".llnw.net", ".lldns.net",
  ".cloudfront.net",
];

function upstreamHeaders(extra = {}) {
  return {
    "user-agent": UA,
    referer: `${SITE_ORIGIN}/en-direct/telequebec`,
    origin: SITE_ORIGIN,
    ...extra,
  };
}

/* ---------------------------------------------------------------- base64url */
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeStr(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}
function b64urlDecodeStr(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* -------------------------------------------------------------------- HMAC */
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signedUrl(origin, absoluteUrl, secret) {
  const exp = Math.floor(Date.now() / 1000) + SIGN_TTL;
  const p = b64urlEncodeStr(absoluteUrl);
  const s = await hmac(secret, `${p}.${exp}`);
  return `${origin}/api/telequebec?p=${p}&e=${exp}&s=${s}`;
}

/* ------------------------------------------------ validation destination SSRF */
function isForbiddenHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  // littéraux IP privés / réservés
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;          // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (h.includes(":")) return true;                          // IPv6 littéral : on refuse
  return false;
}
function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return HOST_ALLOW.some((suf) => h === suf.slice(1) || h.endsWith(suf));
}
function validateTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("URL invalide"); }
  if (u.protocol !== "https:") throw new Error("HTTPS uniquement");
  if (isForbiddenHost(u.hostname)) throw new Error("hôte interdit (IP privée/metadata)");
  if (!hostAllowed(u.hostname)) throw new Error(`hôte non autorisé: ${u.hostname}`);
  return u.href;
}

/* -------------------------------------------------- API officielles / Brightcove */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: upstreamHeaders({ accept: "application/json", ...(options.headers || {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 160)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`JSON invalide depuis ${url}`); }
}

function getLiveIds(epg) {
  const contents = epg?.data?.blocks?.[0]?.widgets?.[0]?.playlist?.contents;
  const item = Array.isArray(contents) ? contents[0] : null;
  const contentId = item?.id;
  const streamId = item?.streams?.[0]?.id;
  if (!contentId || !streamId) throw new Error("Aucun direct actif dans l'EPG officiel");
  return { contentId: String(contentId), streamId: String(streamId), title: item?.title || null };
}
function getBrightcoveIds(streamData) {
  const stream = streamData?.data?.stream;
  const accountId = stream?.video_provider_details?.account_id;
  const videoId = stream?.url;
  if (!accountId || !videoId) throw new Error("account_id/videoId Brightcove manquants");
  return { accountId: String(accountId), videoId: String(videoId) };
}
function findPolicyKey(value) {
  if (!value || typeof value !== "object") return null;
  for (const [k, child] of Object.entries(value)) {
    if ((k === "policyKey" || k === "policy_key") && typeof child === "string") return child;
    const nested = findPolicyKey(child);
    if (nested) return nested;
  }
  return null;
}
async function getPolicyKey(accountId) {
  const base = `https://players.brightcove.net/${encodeURIComponent(accountId)}/default_default`;
  const cfg = await fetch(`${base}/config.json`, {
    headers: upstreamHeaders({ accept: "application/json,*/*" }), redirect: "follow",
  });
  if (cfg.ok) {
    const text = await cfg.text();
    try { const k = findPolicyKey(JSON.parse(text)); if (k) return k; }
    catch { const m = text.match(/(?:policyKey|policy_key)["']?\s*[:=]\s*["']([^"']+)/); if (m) return m[1]; }
  }
  const js = await fetch(`${base}/index.min.js`, {
    headers: upstreamHeaders({ accept: "*/*" }), redirect: "follow",
  });
  if (js.ok) {
    const text = await js.text();
    const m = text.match(/(?:policyKey|policy_key)["']?\s*[:=]\s*["']([^"']+)/);
    if (m) return m[1];
  }
  throw new Error("Clé de politique Brightcove introuvable");
}

function isHls(src) {
  const s = String(src?.src || "").toLowerCase();
  const t = String(src?.type || "").toLowerCase();
  return Boolean(src?.src) && (s.includes(".m3u8") || t.includes("mpegurl") || String(src?.container).toUpperCase() === "M2TS");
}
function isDrm(src) {
  const s = String(src?.src || "").toLowerCase();
  return Boolean(
    src?.key_systems || src?.keySystems || src?.drm ||
    s.includes("playlist_wv") || s.includes("widevine") || s.includes("playready") ||
    s.includes("fairplay") || s.includes("/wv/") || s.includes("cenc") || s.startsWith("skd://")
  );
}

async function resolveLive() {
  const now = Math.floor(Date.now() / 1000);
  const epg = await fetchJson(`${API_ROOT}/epg?device_type=web&device_layout=web&datetimestamp=${now}`);
  const live = getLiveIds(epg);

  const form = new URLSearchParams({ device_layout: "web", device_type: "web" });
  const streamData = await fetchJson(
    `${API_ROOT}/assets/${encodeURIComponent(live.contentId)}/streams/${encodeURIComponent(live.streamId)}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: form.toString() }
  );
  const bc = getBrightcoveIds(streamData);
  const policyKey = await getPolicyKey(bc.accountId);
  const playback = await fetchJson(
    `https://edge.api.brightcove.com/playback/v1/accounts/${encodeURIComponent(bc.accountId)}/videos/${encodeURIComponent(bc.videoId)}`,
    { headers: { accept: `application/json;pk=${policyKey}`, "bcov-policy": policyKey } }
  );

  const sources = Array.isArray(playback.sources) ? playback.sources : [];
  const selected = sources.find((s) => isHls(s) && !isDrm(s)) || null;
  return {
    ...live, ...bc,
    title: playback.name || live.title || null,
    selected,
    sources: sources.map((s) => ({
      hls: isHls(s), drm: isDrm(s),
      type: s?.type || null, container: s?.container || null,
      key_systems: s?.key_systems ? Object.keys(s.key_systems) : null,
      src: s?.src || null,
    })),
  };
}

/* ----------------------------------------------------- réécriture du manifeste */
async function rewriteManifest(text, baseUrl, origin, secret) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t.startsWith("#")) {
      // réécrit URI="..." (clés, EXT-X-MAP init, media, i-frames…)
      let replaced = line;
      const matches = [...line.matchAll(/URI="([^"]+)"/g)];
      for (const m of matches) {
        const abs = new URL(m[1], baseUrl).href;
        const su = await signedUrl(origin, abs, secret);
        replaced = replaced.replace(`URI="${m[1]}"`, `URI="${su}"`);
      }
      out.push(replaced);
      continue;
    }
    const abs = new URL(t, baseUrl).href;
    out.push(await signedUrl(origin, abs, secret));
  }
  return out.join("\n");
}

/* --------------------------------------------------------------- proxy segment */
async function proxySigned(req, target, origin, secret) {
  const headers = upstreamHeaders({ accept: "*/*" });
  const range = req.headers.get("range");
  if (range) headers.range = range;

  const upstream = await fetch(target, { headers, redirect: "follow" });
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`upstream ${upstream.status}`, { status: 502 });
  }

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const finalUrl = upstream.url || target;
  const isManifest = finalUrl.toLowerCase().includes(".m3u8") || ct.includes("mpegurl");

  if (isManifest) {
    const text = await upstream.text();
    const body = await rewriteManifest(text, finalUrl, origin, secret);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "access-control-allow-origin": "*",
        "cache-control": "no-store, max-age=0",
      },
    });
  }

  const h = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(name);
    if (v) h.set(name, v);
  }
  h.set("access-control-allow-origin", "*");
  h.set("cache-control", "public, max-age=60, s-maxage=60"); // segments immuables
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

/* ---------------------------------------------------------------- handler */
export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,HEAD,OPTIONS",
      "access-control-allow-headers": "range",
    }});
  }
  if (!["GET", "HEAD"].includes(req.method)) {
    return new Response("method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const origin = url.origin;
  const secret = (globalThis.process?.env?.TELEQUEBEC_PROXY_SECRET) || "";

  // --- Requête de segment signée (?p=&e=&s=) : jamais d'URL arbitraire ---
  const p = url.searchParams.get("p");
  if (p) {
    if (!secret) return new Response("proxy désactivé (secret non configuré)", { status: 403 });
    const e = url.searchParams.get("e");
    const s = url.searchParams.get("s");
    const now = Math.floor(Date.now() / 1000);
    if (!e || !s) return new Response("signature manquante", { status: 400 });
    if (Number(e) < now) return new Response("lien expiré", { status: 410 });
    const expected = await hmac(secret, `${p}.${e}`);
    if (!timingSafeEqual(s, expected)) return new Response("signature invalide", { status: 403 });
    let target;
    try { target = validateTarget(b64urlDecodeStr(p)); }
    catch (err) { return new Response(`cible refusée: ${err.message}`, { status: 400 }); }
    return proxySigned(req, target, origin, secret);
  }

  // --- Résolution du direct ---
  try {
    const r = await resolveLive();

    if (url.searchParams.get("debug") === "1") {
      return Response.json({
        ok: Boolean(r.selected),
        region: "yul1",
        contentId: r.contentId,
        streamId: r.streamId,
        accountId: r.accountId,
        videoId: r.videoId,
        title: r.title,
        selected: r.selected ? { hls: true, drm: false, type: r.selected.type, url: r.selected.src } : null,
        sources: r.sources,
        secretConfigured: Boolean(secret),
      }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }

    if (!r.selected) {
      return Response.json({
        ok: false,
        error: "Télé-Québec n'expose aucune source HLS publique non chiffrée (DRM).",
        sources: r.sources,
      }, { status: 409, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
    if (!secret) {
      return Response.json({
        ok: false,
        error: "Source claire trouvée mais TELEQUEBEC_PROXY_SECRET non configuré : diffusion désactivée.",
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }

    // proxifie le master ; les sous-manifestes/segments repassent signés
    return proxySigned(req, r.selected.src, origin, secret);
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, {
      status: 502, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
    });
  }
}
