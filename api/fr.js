/**
 * Proxy France — Vercel Edge Function épinglée à Paris (cdg1).
 *
 * Débloque les chaînes géo-FR (TF1, France.tv, Canal+…) depuis le Québec :
 * tout le flux (manifeste + segments) est récupéré depuis une IP française
 * puis relayé à ton lecteur.
 *
 * Deux modes :
 *   /api/fr?id=<tvg-id>   -> résout l'URL ParaTV courante PUIS proxifie (1 saut)
 *   /api/fr?u=<url>       -> proxifie une URL directe (France.tv, Canal+, segments…)
 *
 * SÉCURITÉ — le dépôt est public, donc l'URL du proxy l'est aussi. Sans garde-fou,
 * n'importe qui pourrait s'en servir comme relais anonyme sur le quota Vercel.
 * Trois protections :
 *   1. anti-SSRF : http(s) uniquement, IP privées / loopback / métadonnées bloquées ;
 *   2. allowlist : seuls les hôtes d'entrée de la playlist sont acceptés « nus » ;
 *   3. signature : les URLs de variantes/segments/clés que CE proxy génère sont
 *      signées (HMAC-SHA256), donc lui seul peut fabriquer un lien vers un hôte
 *      arbitraire. Activée dès que la variable d'env PROXY_SECRET est définie.
 * Sans PROXY_SECRET, le proxy reste fonctionnel (rien ne casse) mais en mode
 * permissif : définis la variable dans Vercel pour fermer complètement l'accès.
 */

export const config = { runtime: "edge", regions: ["cdg1"] };

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";
const SELF = "/api/fr?u=";
const UA = "Mozilla/5.0 (SmartTV) AppleWebKit/537.36";
const TIMEOUT_MS = 20000;

// Hôtes d'entrée autorisés sans signature : ce sont ceux référencés directement
// dans TV.m3u (playlist ParaTV + CDN des chaînes servies en ?u=). Le suffixe
// couvre les sous-domaines (ex. « .cloudfront.net » pour les flux Amagi).
const ALLOW_HOSTS = [
  "raw.githubusercontent.com",
  "ott.tv5monde.com",
  ".cloudfront.net",
  ".nextradiotv.com",
];

const SECRET = (typeof process !== "undefined" && process.env && process.env.PROXY_SECRET) || "";

/* ------------------------------------------------------------------ *
 * Signature HMAC des URLs que le proxy génère lui-même
 * ------------------------------------------------------------------ */
let keyPromise = null;
function hmacKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }
  return keyPromise;
}

async function sign(url) {
  if (!SECRET) return "";
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(url));
  const bytes = new Uint8Array(mac);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

// comparaison à temps constant (évite de fuiter la signature octet par octet)
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Garde-fous anti-SSRF
 * ------------------------------------------------------------------ */
function hostAllowed(host) {
  return ALLOW_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

// Bloque les cibles internes : loopback, réseaux privés RFC1918, lien-local,
// et l'IP de métadonnées cloud (169.254.169.254).
function isBlockedTarget(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

async function targetAuthorized(rawUrl, providedSig) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "url invalide";
  }
  if (isBlockedTarget(u)) return "cible interdite";
  if (hostAllowed(u.hostname)) return null; // point d'entrée légitime
  if (!SECRET) return null; // mode permissif tant que PROXY_SECRET n'est pas défini
  if (providedSig && safeEqual(providedSig, await sign(rawUrl))) return null; // lien signé par nous
  return "hôte non autorisé";
}

/* ------------------------------------------------------------------ *
 * Résolution ParaTV + réécriture du manifeste
 * ------------------------------------------------------------------ */
async function resolveParaTV(id) {
  const res = await fetch(PLAYLIST, { headers: { "cache-control": "max-age=60" } });
  if (!res.ok) return null;
  const lines = (await res.text()).split("\n");
  const needle = `tvg-id="${id}"`;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("#EXTINF") && lines[i].includes(needle)) {
      const u = lines[i + 1].trim();
      if (u.startsWith("http")) return u;
    }
  }
  return null;
}

// Toute URL réécrite est signée : c'est ce qui permet de proxifier les segments
// hébergés sur des CDN arbitraires sans ouvrir le proxy à tout le monde.
async function selfUrl(abs, origin) {
  const sig = await sign(abs);
  return `${origin}${SELF}${encodeURIComponent(abs)}${sig ? `&s=${sig}` : ""}`;
}

async function rewriteManifest(text, baseUrl, origin) {
  const out = await Promise.all(
    text.split("\n").map(async (line) => {
      const t = line.trim();
      if (!t) return line;

      if (t.startsWith("#")) {
        // #EXT-X-KEY (clé AES), #EXT-X-MAP (init segment), #EXT-X-MEDIA (audio/sous-titres)
        const parts = [];
        const re = /URI="([^"]+)"/g;
        let last = 0, m;
        while ((m = re.exec(line)) !== null) {
          const abs = new URL(m[1], baseUrl).href;
          parts.push(line.slice(last, m.index), `URI="${await selfUrl(abs, origin)}"`);
          last = m.index + m[0].length;
        }
        if (!parts.length) return line;
        parts.push(line.slice(last));
        return parts.join("");
      }

      const abs = new URL(t, baseUrl).href;
      return await selfUrl(abs, origin);
    })
  );
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
export default async function handler(req) {
  const reqUrl = new URL(req.url);
  const origin = reqUrl.origin;
  const id = reqUrl.searchParams.get("id");
  const sig = reqUrl.searchParams.get("s") || "";
  let target = reqUrl.searchParams.get("u");

  if (id && !target) {
    target = await resolveParaTV(id);
    if (!target) return new Response("id introuvable: " + id, { status: 404 });
  }
  if (!target) return new Response("usage: /api/fr?id=<tvg-id> ou ?u=<url>", { status: 400 });

  const refus = await targetAuthorized(target, sig);
  if (refus) return new Response(refus, { status: 403 });

  let upstream;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const tOrigin = new URL(target).origin;
    const h = {
      "user-agent": UA,
      // certains CDN telco (netplus…) exigent un Referer/Origin
      referer: tOrigin + "/",
      origin: tOrigin,
    };
    // Transmet le Range du lecteur : nécessaire pour que certains players
    // récupèrent les segments par morceaux (et pour le seek).
    const range = req.headers.get("range");
    if (range) h.range = range;

    upstream = await fetch(target, { headers: h, redirect: "follow", signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    return new Response("fetch error: " + e, { status: 502 });
  }
  clearTimeout(timer);
  if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502 });

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const isManifest =
    (upstream.url || target).toLowerCase().includes(".m3u8") ||
    ct.includes("mpegurl");

  if (isManifest) {
    const text = await upstream.text();
    const out = await rewriteManifest(text, upstream.url || target, origin);
    return new Response(out, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
      },
    });
  }

  const h = new Headers();
  const pct = upstream.headers.get("content-type");
  if (pct) h.set("content-type", pct);
  for (const k of ["content-range", "accept-ranges", "content-length"]) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("access-control-allow-origin", "*");
  // Les segments de média (fMP4/TS) sont immuables une fois produits :
  // on les met en cache sur le CDN Vercel (PoP proche du lecteur) pour
  // éviter un aller-retour jusqu'à Paris à chaque segment → moins de buffering.
  h.set("cache-control", "public, max-age=300, s-maxage=300");
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
