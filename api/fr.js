/**
 * Proxy France — Vercel Edge Function épinglée à Paris (cdg1).
 *
 * Débloque les chaînes géo-FR (TF1, France.tv, Canal+…) depuis le Québec :
 * tout le flux (manifeste + segments) est récupéré depuis une IP française
 * puis relayé à ton lecteur.
 *
 * Modes :
 *   /api/fr?id=<tvg-id>[&name=<nom>]  -> résolution AVEC BASCULEMENT : essaie
 *       plusieurs sources (registre local + ParaTV + agrégateur maintenu),
 *       valide chacune en direct (rejette DRM/morts), sert la 1re qui marche,
 *       et met le gagnant en cache court. L'URL dans la playlist ne change
 *       donc JAMAIS ; si une source tombe, la suivante prend le relais au zap.
 *   /api/fr?u=<url>                   -> proxifie une URL directe (segments…)
 */

export const config = { runtime: "edge", regions: ["cdg1"] };

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";
const SELF = "/api/fr?u=";
const UA = "Mozilla/5.0 (SmartTV) AppleWebKit/537.36";

// Agrégateur FR maintenu, interrogé en direct (id puis nom) comme source de
// candidats supplémentaire — s'ajoute au registre, aucune maintenance à la main.
const AGG = "https://raw.githubusercontent.com/schumijo/iptv/main/fr.m3u8";

// Registre de secours : liste ORDONNÉE de candidats par chaîne. On garde le 1er
// qui renvoie un vrai manifeste HLS clair (les entrées mortes/DRM/géo sont
// sautées à l'exécution). Plusieurs candidats = basculement automatique.
const REGISTRY = {
  "M6.fr": [
    "http://gratuittv.free.fr/Files/m6/live/playlist.m3u8",
    "https://origin-18cd60dea8190528.live.6cloud.fr/out/v1/72072059b9d541feac3c9328728d8304/cmaf/hlsfmp4_short_fp00_m6_hd_index.m3u8",
    "http://cdn.haititivi.com/M6-HD/index.m3u8",
  ],
  "6ter.fr": [
    "http://gratuittv.free.fr/Files/6ter/live/playlist.m3u8",
    "http://151.80.18.177:86/6ter/index.m3u8",
  ],
  "Gulli.fr": [
    "https://origin-caf900c010ea8046.live.6cloud.fr/out/v1/c65696b42ca34e97a9b5f54758d6dd50/cmaf/hlsfmp4_short_q2hyb21h_gulli_sd_index.m3u8",
    "https://stream1.freetv.fun/027cd356ec6b03bd62d4ccb17fc487c1dca3fd05bdbec771634fa361772de734.m3u8",
  ],
  "W9.fr": [
    "https://origin-m6web.live.6cloud.fr/out/v1/6play/6play-w9/cmaf_q2hyb21h/hls-short-hd.m3u8",
  ],
  "AB1.fr": ["http://151.80.18.177:86/AB1/index.m3u8"],
  "RTL9.fr": ["https://stream1.freetv.fun/2a569fd6415093249fce62ab816170066135e2812d78362b181bcfd75824626d.m3u8"],
  "TeletoonPlus.fr": ["http://cdn.haititivi.com/TELETOON-HD/index.m3u8"],
  "ParisPremiere.fr": ["http://cdn.haititivi.com/PARIS-PREMIERE/index.m3u8"],
  "Nickelodeon.fr": ["http://151.80.18.177:86/Nickelodeon_FR/index.m3u8"],
  "NickelodeonJunior.fr": ["http://151.80.18.177:86/Nickelodeon_Junior/index.m3u8"],
  "DisneyJunior.fr": ["http://151.80.18.177:86/Disney_Junior_HD/index.m3u8"],
};

// Caches mémoire (persistent par isolate Vercel) : playlists sources + gagnant.
const SRC_TTL = 300_000;  // 5 min : texte des playlists sources
const WIN_TTL = 90_000;   // 90 s : URL gagnante par chaîne
const _srcCache = new Map(); // url -> {t, text}
const _winCache = new Map(); // id  -> {t, url}

async function fetchText(url) {
  const c = _srcCache.get(url);
  if (c && Date.now() - c.t < SRC_TTL) return c.text;
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
    if (!r.ok) return "";
    const text = await r.text();
    _srcCache.set(url, { t: Date.now(), text });
    return text;
  } catch {
    return "";
  }
}

function norm(s) {
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Cherche dans un texte de playlist les URL par tvg-id exact puis par nom.
function lookupInPlaylist(text, id, name) {
  const out = [];
  const lines = text.split("\n");
  const wantId = id ? `tvg-id="${id}"` : null;
  const wantName = name ? norm(name) : null;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith("#EXTINF")) continue;
    const dn = lines[i].includes(",") ? lines[i].split(",").pop() : "";
    const byId = wantId && lines[i].includes(wantId);
    const byName = wantName && norm(dn) === wantName;
    if (byId || byName) {
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
      const u = j < lines.length ? lines[j].trim() : "";
      if (u.startsWith("http")) out.push(u);
    }
  }
  return out;
}

// Un manifeste est acceptable s'il commence par #EXTM3U et ne porte pas de DRM
// (FairPlay/SAMPLE-AES). L'AES-128 à clé récupérable reste géré par le proxy.
function isCleanHls(text) {
  if (!text || !text.trimStart().startsWith("#EXTM3U")) return false;
  if (/#EXT-X-(SESSION-)?KEY[^\n]*(SAMPLE-AES|skd:|com\.apple\.fps|widevine|playready)/i.test(text)) return false;
  if (/URI="skd:/i.test(text)) return false;
  return true;
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const o = new URL(url).origin;
    const r = await fetch(url, {
      headers: { "user-agent": UA, referer: o + "/", origin: o },
      redirect: "follow", signal: ctrl.signal,
    });
    if (!r.ok) return false;
    const head = (await r.text()).slice(0, 2000);
    return isCleanHls(head);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(id, name) {
  if (!id && !name) return null;
  const key = id || name;
  const cached = _winCache.get(key);
  if (cached && Date.now() - cached.t < WIN_TTL) return cached.url;

  // 1) registre local  2) ParaTV  3) agrégateur maintenu (id puis nom)
  const cands = [];
  const push = (u) => { if (u && u.startsWith("http") && !cands.includes(u)) cands.push(u); };
  (REGISTRY[id] || []).forEach(push);
  lookupInPlaylist(await fetchText(PLAYLIST), id, name).forEach(push);
  lookupInPlaylist(await fetchText(AGG), id, name).forEach(push);

  for (const u of cands.slice(0, 8)) {
    if (await probe(u)) {
      _winCache.set(key, { t: Date.now(), url: u });
      return u;
    }
  }
  return null;
}

function rewriteManifest(text, baseUrl, origin) {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          const abs = new URL(u, baseUrl).href;
          return `URI="${origin}${SELF}${encodeURIComponent(abs)}"`;
        });
      }
      const abs = new URL(t, baseUrl).href;
      return `${origin}${SELF}${encodeURIComponent(abs)}`;
    })
    .join("\n");
}

export default async function handler(req) {
  const reqUrl = new URL(req.url);
  const origin = reqUrl.origin;
  const id = reqUrl.searchParams.get("id");
  const name = reqUrl.searchParams.get("name");
  let target = reqUrl.searchParams.get("u");

  if (!target && (id || name)) {
    target = await resolve(id, name);
    if (!target) return new Response("aucune source live pour: " + (id || name), { status: 502 });
  }
  if (!target) return new Response("usage: /api/fr?id=<tvg-id> ou ?u=<url>", { status: 400 });

  let upstream;
  try {
    const tOrigin = new URL(target).origin;
    upstream = await fetch(target, {
      headers: {
        "user-agent": UA,
        // certains CDN telco (netplus…) exigent un Referer/Origin
        referer: tOrigin + "/",
        origin: tOrigin,
      },
      redirect: "follow",
    });
  } catch (e) {
    return new Response("fetch error: " + e, { status: 502 });
  }
  if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502 });

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const isManifest =
    (upstream.url || target).toLowerCase().includes(".m3u8") ||
    ct.includes("mpegurl");

  if (isManifest) {
    const text = await upstream.text();
    const out = rewriteManifest(text, upstream.url || target, origin);
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
  h.set("access-control-allow-origin", "*");
  // Les segments de média (fMP4/TS) sont immuables une fois produits :
  // on les met en cache sur le CDN Vercel (PoP proche du lecteur) pour
  // éviter un aller-retour jusqu'à Paris à chaque segment → moins de buffering.
  h.set("cache-control", "public, max-age=300, s-maxage=300");
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
