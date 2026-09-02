/**
 * Proxy France — Vercel Edge Function épinglée à Paris (cdg1).
 *
 * Débloque les chaînes géo-FR (TF1, France.tv, Canal+…) depuis le Québec :
 * tout le flux (manifeste + segments) est récupéré depuis une IP française
 * puis relayé à ton lecteur.
 *
 * Trois modes :
 *   /api/fr?id=<tvg-id>   -> résout l'URL ParaTV courante PUIS proxifie (1 saut)
 *   /api/fr?dm=<video-id> -> résout le live Dailymotion PUIS proxifie (CSTAR…)
 *   /api/fr?u=<url>       -> proxifie une URL directe (France.tv, Canal+, segments…)
 *
 * Pourquoi dm= : les stubs ParaTV sourcés Dailymotion sont rafraîchis par un job
 * quotidien (15:19 CEST) qui échoue régulièrement — le jeton dmcdn du stub gèle
 * alors sur place, expire, et CHAQUE segment demandé devient un 502 (c'est la
 * cause des alertes « 502 on /api/fr » du 22/07 et du 07/08). En mode dm= on
 * demande un jeton frais à Dailymotion à chaque chargement du manifeste, donc
 * plus aucune dépendance à ce job. &fb=<url> = repli si la résolution échoue
 * (au pire on retrouve exactement le comportement stub d'avant).
 *
 * JETONS QUI EXPIRENT EN COURS DE LECTURE (constat du 2026-09-02, panne TF1
 * « hier soir ») : les stubs ParaTV ne sont pas des flux, ce sont des manifestes
 * maîtres dont chaque variante porte un JETON à durée limitée — JWT de 4 h chez
 * TF1 (dossier renouvelé toutes les ~3 h et l'ancien SUPPRIMÉ), « exp=… » chez
 * France TV, « __token__exp=… » chez Canal+. Le proxy réécrivait ces variantes en
 * liens signés qui figeaient le jeton : un lecteur qui zappait sur un jeton déjà
 * vieux de 3 h était coupé 1 h plus tard, et rien ne le relançait. Désormais,
 * pour un stub GitHub, chaque variante devient « &v=<n> » : à CHAQUE relecture de
 * la playlist média (toutes les ~6 s) le proxy relit le stub — mis en cache
 * quelques dizaines de secondes — et repart du jeton le plus frais. Un stub
 * disparu (dossier TF1 renouvelé) est suivi via la playlist ParaTV, et le
 * dernier stub encore valide sert de secours le temps que GitHub rafraîchisse.
 *
 * &fb=<url .m3u8> (modes id= et u=) : si le stub est introuvable, expiré ou
 * refusé par le CDN, le manifeste maître répond 302 vers cette adresse de
 * secours — le lecteur la lit alors EN DIRECT (rien ne transite par Vercel).
 *
 * SÉCURITÉ — le dépôt est public, donc l'URL du proxy l'est aussi. Sans garde-fou,
 * n'importe qui pourrait s'en servir comme relais anonyme sur le quota Vercel.
 * Trois protections :
 *   1. anti-SSRF : http(s) uniquement, IP privées / loopback / métadonnées bloquées ;
 *   2. allowlist : seuls les hôtes d'entrée de la playlist sont acceptés « nus » ;
 *   3. signature : les URLs de variantes/segments/clés que CE proxy génère sont
 *      signées (HMAC-SHA256), donc lui seul peut fabriquer un lien vers un hôte
 *      arbitraire. Activée dès que la variable d'env PROXY_SECRET est définie ;
 *   4. redirections suivies à la main, chaque saut revérifié (voir
 *      fetchFollowingSafely) : un hôte autorisé ne peut pas renvoyer le proxy
 *      vers une adresse interne.
 * Sans PROXY_SECRET, rien ne s'ouvre — au contraire : les liens signés sont
 * alors refusés et seuls les hôtes de la liste blanche passent. La variable
 * sert à ÉLARGIR aux CDN de segments, pas à fermer l'accès.
 * Le repli fb= n'est jamais relayé (302 seulement) et n'accepte qu'une adresse
 * http(s) de manifeste .m3u8 : pas de redirection ouverte vers n'importe quoi.
 */

export const config = { runtime: "edge", regions: ["cdg1"] };

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";
const SELF = "/api/fr?u=";
const UA = "Mozilla/5.0 (SmartTV) AppleWebKit/537.36";
const TIMEOUT_MS = 20000;

// Domaines réellement traversés par les chaînes proxifiées — manifeste maître,
// variantes, segments et clés AES — relevés automatiquement par le workflow
// `collect-hosts`. Tout le reste est refusé : c'est ce qui empêche un tiers
// d'utiliser le proxy comme relais anonyme sur le quota Vercel.
// Un nom commençant par « . » couvre les sous-domaines (les CDN font tourner
// leurs noms d'edge : hls-m015…, alive-tmc-hls…), sinon la correspondance est
// exacte.
//
// Si une chaîne tombe en 403 « hôte non autorisé », c'est que son CDN a changé
// de domaine : relance le workflow `collect-hosts` et ajoute le domaine ici.
const ALLOW_HOSTS = [
  "raw.githubusercontent.com",          // fichiers de flux ParaTV
  "ott.tv5monde.com",                   // TV5Monde Info
  "d15aro46bnpfm8.cloudfront.net",      // RMC Story (Amagi)
  ".tf1.fr",                            // TF1, TMC, TFX, LCI, TF1 Séries Films, Novo 19
  ".ftven.fr",                          // France 2/3/4/5, Arte, franceinfo, FTV Docs/Séries
  ".nextradiotv.com",                   // BFM TV
  ".canalplus-cdn.net",                 // CANAL+ en clair, CNews
  ".dmcdn.net",                         // CSTAR, T18 (Dailymotion, segments)
  ".dailymotion.com",                   // CSTAR, T18 : depuis 2026-09 le manifeste
                                        // résolu vit sur cdndirector.dailymotion.com
                                        // (qui redirige vers dmcdn) — sans lui, le
                                        // mode dm= répondait « hôte non autorisé »
];
// N'AJOUTE PAS .6cloud.fr / .bedrock.tech : essayé le 2026-08-30, les 6 flux
// officiels du groupe M6 (M6, W9, 6ter, Gulli, Paris Première) renvoient 502
// à travers le proxy — 6cloud refuse les IP de datacenter Vercel, quelle que
// soit l'allowlist. Le blocage est côté CDN, pas côté proxy : ouvrir ces
// domaines n'apporterait rien et élargirait la surface pour rien.

// Hôte des stubs (manifestes maîtres à jetons, rafraîchis par leur mainteneur) :
// c'est pour eux que la relecture « &v=<n> » a un sens.
const STUB_HOST = "raw.githubusercontent.com";

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
  // `URL.hostname` GARDE les crochets d'une adresse IPv6 : « http://[::1]/ »
  // donne « [::1] », qui ne valait aucune des comparaisons ci-dessous — le
  // loopback IPv6 passait donc au travers. On les retire d'abord.
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  // Forme IPv4 encapsulée dans de l'IPv6 : on ne juge que la partie v4, sinon
  // elle échapperait aux deux familles de tests. Attention, `URL` normalise
  // « ::ffff:127.0.0.1 » en « ::ffff:7f00:1 » — c'est cette écriture-là qu'on
  // rencontre en pratique, il faut donc la reconvertir.
  let v4 = h;
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  } else if (h.startsWith("::ffff:")) {
    v4 = h.slice(7);
  }
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;
    // Lien-local, c'est fe80::/10 — donc fe80 A febf, pas seulement « fe80 ».
    // Un simple prefixe de chaine laissait passer fe90::, fea0::, feb0::…
    const first = parseInt(h.split(":")[0] || "0", 16);
    if (first >= 0xfe80 && first <= 0xfebf) return true;
  }
  return false;
}

/**
 * Suit les redirections À LA MAIN, en revérifiant chaque saut.
 *
 * `redirect: "follow"` laissait le garde-fou derrière : seule la PREMIÈRE URL
 * était contrôlée, et un hôte autorisé qui répond « 302 vers 169.254.169.254 »
 * faisait relayer une adresse interne par le proxy. Le dépôt étant public,
 * l'astuce est lisible par quiconque.
 *
 * Ce qu'on revérifie à chaque saut : l'adresse ne doit jamais être interne.
 * Ce qu'on ne revérifie PAS : l'appartenance à la liste blanche — une
 * redirection vers un autre CDN est le fonctionnement normal d'un flux, et
 * la cible du saut est choisie par l'hôte amont, pas par l'appelant. Le seul
 * choix laissé à l'appelant, l'URL de départ, est resté sous contrôle.
 */
const MAX_REDIRECTS = 5;
async function fetchFollowingSafely(target, headers, signal) {
  let url = target;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { headers, redirect: "manual", signal });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    if (hop >= MAX_REDIRECTS) throw new Error("trop de redirections");
    let next;
    try {
      next = new URL(loc, url);
    } catch {
      throw new Error("redirection invalide");
    }
    if (isBlockedTarget(next)) throw new Error("redirection vers une cible interdite");
    url = next.toString();
  }
}

async function targetAuthorized(rawUrl, providedSig, derived = false) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "url invalide";
  }
  if (isBlockedTarget(u)) return "cible interdite";
  if (hostAllowed(u.hostname)) return null; // domaine d'une chaîne de la playlist
  // Lien signé par le proxy lui-même (permet n'importe quel CDN sans rouvrir
  // le proxy) — actif seulement si PROXY_SECRET est défini.
  if (SECRET && providedSig && safeEqual(providedSig, await sign(rawUrl))) return null;
  // Variante « &v=<n> » : l'URL a été lue par le proxy lui-même dans un stub
  // qu'il vient de récupérer — même confiance qu'un lien signé, mêmes conditions.
  if (SECRET && derived) return null;
  return `hôte non autorisé: ${u.hostname}`;
}

/* ------------------------------------------------------------------ *
 * Résolution ParaTV + réécriture du manifeste
 * ------------------------------------------------------------------ */
// Live Dailymotion -> URL master fraîchement signée. Renvoie {url} ou {error}
// (l'erreur est reprise telle quelle dans le corps du 502 : elle nomme l'étape
// exacte qui a échoué, ce qui évite de deviner depuis les logs Vercel).
async function resolveDailymotion(videoId, embedder) {
  if (!/^[a-zA-Z0-9]{5,12}$/.test(videoId)) return { error: "id dailymotion invalide" };
  let meta;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const qs = embedder ? "?embedder=" + encodeURIComponent(embedder) : "";
    const res = await fetch(
      "https://www.dailymotion.com/player/metadata/video/" + videoId + qs,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          referer: embedder || "https://www.dailymotion.com/",
        },
        signal: ctrl.signal,
      }
    );
    if (!res.ok) return { error: "metadata http " + res.status };
    meta = await res.json();
  } catch (e) {
    return { error: "metadata fetch: " + e };
  } finally {
    clearTimeout(timer);
  }
  if (meta?.error)
    return { error: "metadata: " + (meta.error.title || meta.error.message || "refusée") };
  // Premier flux HLS parmi toutes les qualités : certains lives listent du DASH
  // en premier, et un .mpd proxifié brut est illisible pour le lecteur.
  let fallback = null;
  for (const arr of Object.values(meta?.qualities || {})) {
    if (!Array.isArray(arr)) continue;
    for (const q of arr) {
      const u = q && typeof q.url === "string" && q.url.startsWith("http") ? q.url : null;
      if (!u) continue;
      fallback = fallback || u;
      if ((q.type || "").toLowerCase().includes("mpegurl") || u.includes(".m3u8"))
        return { url: u };
    }
  }
  if (fallback) return { url: fallback };
  return { error: "aucun flux (onair=" + (meta?.onair ?? "?") + ")" };
}

// Cache mémoire très court. L'isolate Edge survit d'une requête à l'autre, et
// chaque lecteur relit sa playlist média toutes les ~6 s : sans ce cache, chaque
// relecture irait rechercher la playlist ParaTV (150 Ko) et le stub sur GitHub.
const RESOLVE_TTL_MS = 45_000;
const memo = new Map();
async function memoized(key, fn) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  // Un échec n'est jamais mis en cache : la prochaine requête retente.
  if (value !== null && value !== undefined) memo.set(key, { value, until: Date.now() + RESOLVE_TTL_MS });
  return value;
}

async function resolveParaTV(id) {
  // Le CDN de raw.githubusercontent.com peut servir une copie vieille de
  // quelques minutes ; or ParaTV déplace ses stubs TF1 toutes les ~3 h et
  // supprime l'ancien dossier. La minute courante dans l'URL force une copie
  // fraîche à chaque minute (paramètre ignoré par GitHub, mais pas par son cache).
  const res = await fetch(PLAYLIST + "?_=" + Math.floor(Date.now() / 60000), {
    headers: { "user-agent": UA, "cache-control": "max-age=60" },
  });
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

// Manifeste maître d'un stub : {text, base} ou null s'il ne répond pas / n'est
// pas un manifeste (dossier ParaTV supprimé -> 404).
async function fetchStub(stubUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(stubUrl, { headers: { "user-agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trimStart().startsWith("#EXTM3U")) return null;
    return { text, base: res.url || stubUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Toutes les URI d'un manifeste maître, dans l'ordre du document : les lignes
// nues (variantes) ET les attributs URI="…" (#EXT-X-MEDIA audio/sous-titres,
// #EXT-X-KEY…). rewriteStub numérote dans le même ordre : « &v=<n> » désigne
// donc toujours la même entrée, quel que soit le moment où le stub est relu.
function urisOf(text, base) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      for (const m of line.matchAll(/URI="([^"]+)"/g)) out.push(new URL(m[1], base).href);
    } else {
      out.push(new URL(t, base).href);
    }
  }
  return out;
}

// Date d'expiration (secondes epoch) du jeton porté par une URI, ou null.
// Formes connues : JWT dans le chemin (TF1 : « /eyJ….eyJ…./ », champ exp),
// segment base64 « exp=…~acl=…~hmac=… » (France TV), « __token__exp=… »
// (Canal+), « hdnts=exp=… » / « hdnea=exp=… » (Akamai).
function tokenExp(uri) {
  let m = /\/eyJ[\w-]*\.(eyJ[\w-]*)\./.exec(uri);
  if (m) {
    try {
      const payload = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const p = JSON.parse(atob(payload + "=".repeat((4 - (payload.length % 4)) % 4)));
      if (typeof p.exp === "number") return p.exp;
    } catch {}
  }
  m = /(?:__token__|hdnts=|hdnea=)exp(?:=|%3D)(\d{9,10})/i.exec(uri);
  if (m) return Number(m[1]);
  for (const seg of uri.split("/")) {
    if (!seg.startsWith("ZXhwPT")) continue; // base64 de « exp= »
    try {
      const d = atob(seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (seg.length % 4)) % 4));
      const e = /^exp=(\d{9,10})/.exec(d);
      if (e) return Number(e[1]);
    } catch {}
  }
  return null;
}

// Expiration la plus proche parmi les URI d'un stub (null si aucun jeton).
function earliestExp(uris) {
  let min = null;
  for (const u of uris) {
    const e = tokenExp(u);
    if (e !== null && (min === null || e < min)) min = e;
  }
  return min;
}

// Manifeste maître réécrit : chaque URI devient « <même requête>&v=<n> ».
// `self` = origin + « /api/fr?id=… » ou « /api/fr?u=… » (sans v).
function rewriteStub(text, self) {
  let n = 0;
  const link = () => `${self}&v=${n++}`;
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, () => `URI="${link()}"`);
      return link();
    })
    .join("\n");
}

// Dernier stub valide par clé (id= ou URL de stub) : sert de secours quand le
// stub frais est introuvable — typiquement les quelques minutes où le cache de
// GitHub sert encore l'ancienne playlist ParaTV alors que l'ancien dossier a
// déjà été supprimé. Les jetons de l'ancien stub restent valables jusqu'à exp.
const lastGood = new Map();

// Résout le stub d'une chaîne : {text, base, uris, exp} ou {error}.
//   id  : tvg-id ParaTV (l'URL du stub est relue dans la playlist), sinon
//   url : URL de stub directe (mode u=)
async function resolveStub(id, url) {
  const key = id ? "id:" + id : "u:" + url;
  const stubUrlOf = () => (id ? memoized("pl:" + id, () => resolveParaTV(id)) : Promise.resolve(url));
  let stubUrl = await stubUrlOf();
  let stub = stubUrl ? await memoized("stub:" + stubUrl, () => fetchStub(stubUrl)) : null;
  if (!stub && id) {
    // Dossier ParaTV renouvelé entre-temps ? On repart d'une playlist fraîche.
    memo.delete("pl:" + id);
    const fresh = await stubUrlOf();
    if (fresh && fresh !== stubUrl) {
      stubUrl = fresh;
      stub = await memoized("stub:" + stubUrl, () => fetchStub(stubUrl));
    }
  }
  const now = Date.now() / 1000;
  if (stub) {
    const uris = urisOf(stub.text, stub.base);
    const exp = earliestExp(uris);
    if (!uris.length) return { error: "stub sans flux: " + stubUrl };
    if (exp !== null && exp < now) {
      // Le mainteneur du stub n'a pas rafraîchi son jeton : inutile d'insister.
      const old = lastGood.get(key);
      if (old && old.exp !== null && old.exp > now) return old;
      return { error: `jeton du stub expiré depuis ${Math.round((now - exp) / 60)} min: ${stubUrl}` };
    }
    const r = { text: stub.text, base: stub.base, uris, exp };
    lastGood.set(key, r);
    return r;
  }
  const old = lastGood.get(key);
  if (old && (old.exp === null || old.exp > now)) return old;
  return { error: stubUrl ? "stub injoignable: " + stubUrl : "id introuvable: " + id };
}

// Adresse de repli acceptable : http(s), manifeste .m3u8, pas une cible interne.
// Le proxy ne la relaie jamais (302 seulement) — le lecteur la lit en direct.
function fallbackTarget(fb) {
  if (!fb) return null;
  let u;
  try {
    u = new URL(fb);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.pathname.toLowerCase().endsWith(".m3u8")) return null;
  if (isBlockedTarget(u)) return null;
  return u.toString();
}

function failOrFallback(reason, fb) {
  const t = fallbackTarget(fb);
  if (t) {
    return new Response(null, {
      status: 302,
      headers: { location: t, "cache-control": "no-store", "x-fr-fallback": "1" },
    });
  }
  return new Response(reason, { status: 502 });
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

// Reconnaît un vrai segment média à ses premiers octets, quand le CDN annonce
// un Content-Type fantaisiste (Dailymotion, 2026-09-02 : « text/vnd.trolltech.
// linguist » sur du MPEG-TS — CSTAR et T18 étaient refusées en 415). Renvoie
// le type à servir, ou null si ce n'est manifestement pas du média.
function sniffMedia(head, path) {
  const b = head || new Uint8Array();
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 1 && b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return "video/mp2t";
  if (b.length >= 8 && ["ftyp", "styp", "moof", "sidx", "moov"].includes(ascii(4, 4))) return "video/mp4";
  if (b.length >= 6 && ascii(0, 6) === "WEBVTT") return "text/vtt";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0 && path.endsWith(".aac")) return "audio/aac";
  if (path.endsWith(".key") && b.length === 16) return "application/octet-stream";
  return null;
}

// Lit le premier morceau d'un flux et rend un flux équivalent (le morceau lu
// suivi du reste), pour pouvoir regarder les octets sans rien perdre.
async function peek(body) {
  if (!body) return { head: new Uint8Array(), rest: null };
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.value || new Uint8Array();
  const rest = new ReadableStream({
    start(c) {
      if (head.length) c.enqueue(head);
      if (first.done) c.close();
    },
    async pull(c) {
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, rest };
}

const MANIFEST_HEADERS = {
  "content-type": "application/vnd.apple.mpegurl",
  "access-control-allow-origin": "*",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
};

function upstreamHeaders(target, req) {
  const tOrigin = new URL(target).origin;
  const h = {
    "user-agent": UA,
    // certains CDN telco (netplus…) exigent un Referer/Origin
    referer: tOrigin + "/",
    origin: tOrigin,
  };
  // Transmet le Range du lecteur : nécessaire pour que certains players
  // récupèrent les segments par morceaux (et pour le seek).
  const range = req && req.headers.get("range");
  if (range) h.range = range;
  return h;
}

/* ------------------------------------------------------------------ */
export default async function handler(req) {
  const reqUrl = new URL(req.url);
  const origin = reqUrl.origin;
  const id = reqUrl.searchParams.get("id");
  const sig = reqUrl.searchParams.get("s") || "";
  const v = reqUrl.searchParams.get("v");
  const fb = reqUrl.searchParams.get("fb");
  let target = reqUrl.searchParams.get("u");

  const dm = reqUrl.searchParams.get("dm");

  if (id && !target) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return new Response("id invalide", { status: 400 });
  }

  // Stub GitHub (mode id=, ou u= pointant sur un stub) : manifeste maître
  // réécrit en « &v=<n> », et chaque « v= » relu depuis le stub du moment.
  let stubHost = false;
  if (target && v !== null) {
    try {
      stubHost = new URL(target).hostname === STUB_HOST;
    } catch {}
  }
  let derived = false; // target lu par le proxy dans un stub (variante « v= »)
  if ((id && !target) || (stubHost && v !== null)) {
    const r = id && !target ? await resolveStub(id, null) : await resolveStub(null, target);
    if (r.error) return v === null ? failOrFallback(r.error, fb) : new Response(r.error, { status: 502 });
    if (v !== null) {
      const i = Number(v);
      if (!Number.isInteger(i) || i < 0 || i >= r.uris.length)
        return new Response("variante inconnue: " + v, { status: 404 });
      target = r.uris[i]; // puis chemin normal : garde-fous, fetch, réécriture des segments
      derived = true;
    } else {
      // Manifeste maître. On sonde d'abord la première entrée : un CDN qui
      // refuse l'IP du proxy (403) se voit ici, et le repli peut jouer —
      // plutôt qu'un manifeste dont chaque variante donnerait 502.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchFollowingSafely(r.uris[0], upstreamHeaders(r.uris[0]), ctrl.signal);
        if (res.body) res.body.cancel().catch(() => {});
        if (!res.ok) return failOrFallback("variante upstream " + res.status, fb);
      } catch (e) {
        return failOrFallback("variante: " + e, fb);
      } finally {
        clearTimeout(timer);
      }
      const self = id ? `${origin}/api/fr?id=${encodeURIComponent(id)}` : `${origin}${SELF}${encodeURIComponent(target)}`;
      return new Response(rewriteStub(r.text, self), { status: 200, headers: MANIFEST_HEADERS });
    }
  }
  if (dm && !target) {
    const r = await resolveDailymotion(dm, reqUrl.searchParams.get("ref"));
    // Repli sur fb= (typiquement le stub ParaTV) : le mode dm= ne peut donc
    // jamais faire pire que l'ancien comportement. fb= repasse par les mêmes
    // garde-fous que u= juste en dessous. Une URL résolue mais refusée par la
    // liste blanche (Dailymotion change parfois d'hôte) compte comme un échec
    // de résolution : on préfère le stub à un 403 sec.
    target = r.url && !(await targetAuthorized(r.url, "")) ? r.url : fb;
    if (!target)
      return new Response("dailymotion " + dm + " irrésoluble — " + (r.error || "hôte refusé"), { status: 502 });
  }
  if (!target)
    return new Response("usage: /api/fr?id=<tvg-id>, ?dm=<video-id> ou ?u=<url>", { status: 400 });

  const refus = await targetAuthorized(target, sig, derived);
  if (refus) return new Response(refus, { status: 403 });

  let upstream;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    upstream = await fetchFollowingSafely(target, upstreamHeaders(target, req), ctrl.signal);
  } catch (e) {
    clearTimeout(timer);
    return new Response("fetch error: " + e, { status: 502 });
  }
  clearTimeout(timer);
  if (!upstream.ok) {
    // Un stub GitHub demandé en u= sans v= (manifeste maître) qui ne répond
    // pas : c'est le cas du repli, pas celui d'un segment.
    if (v === null && !dm) {
      let isStub = false;
      try {
        isStub = new URL(target).hostname === STUB_HOST;
      } catch {}
      if (isStub) return failOrFallback("upstream " + upstream.status, fb);
    }
    return new Response("upstream " + upstream.status, { status: 502 });
  }

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  // Le chemin seul, pas l'URL entière : sinon un « ?x=.m3u8 » dans la query
  // ferait passer n'importe quelle réponse pour un manifeste.
  let path = "";
  try {
    path = new URL(upstream.url || target).pathname.toLowerCase();
  } catch {}
  const isManifest = path.endsWith(".m3u8") || path.endsWith(".m3u") || ct.includes("mpegurl");

  // Refuse les réponses trop grosses (un fichier géant ferait exploser
  // l'isolate Edge et brûlerait le quota).
  const len = Number(upstream.headers.get("content-length") || 0);
  const MAX = isManifest ? 4 * 1024 * 1024 : 64 * 1024 * 1024;
  if (len > MAX) return new Response("réponse trop volumineuse", { status: 502 });

  if (isManifest) {
    const text = await upstream.text();
    // Un stub GitHub lu en u= (France TV, Canal+…) : ses variantes portent des
    // jetons qui expirent ; on les sert en « &v=<n> » pour les relire à chaque
    // fois plutôt que de figer le jeton dans des liens signés.
    let isStub = false;
    try {
      isStub = v === null && !dm && new URL(target).hostname === STUB_HOST && text.includes("#EXT-X-STREAM-INF");
    } catch {}
    if (isStub) {
      const uris = urisOf(text, upstream.url || target);
      const exp = earliestExp(uris);
      if (exp !== null && exp < Date.now() / 1000)
        return failOrFallback(`jeton du stub expiré depuis ${Math.round((Date.now() / 1000 - exp) / 60)} min`, fb);
      if (uris.length) {
        lastGood.set("u:" + target, { text, base: upstream.url || target, uris, exp });
        memo.set("stub:" + target, { value: { text, base: upstream.url || target }, until: Date.now() + RESOLVE_TTL_MS });
        return new Response(rewriteStub(text, `${origin}${SELF}${encodeURIComponent(target)}`), {
          status: 200,
          headers: MANIFEST_HEADERS,
        });
      }
    }
    const out = await rewriteManifest(text, upstream.url || target, origin);
    return new Response(out, { status: 200, headers: MANIFEST_HEADERS });
  }

  // Liste blanche des types renvoyés : le proxy ne doit servir que du média.
  // Sans ça il peut rendre du HTML/JS arbitraire sous ton domaine vercel.app
  // (hameçonnage hébergé chez toi -> risque de suspension du compte, ce qui
  // couperait toutes les chaînes proxifiées).
  const MEDIA_OK = ["video/", "audio/", "application/octet-stream",
                    "application/x-mpegurl", "application/vnd.apple.mpegurl",
                    "binary/octet-stream", "application/mp4", "image/",
                    "text/vtt"];                       // sous-titres WebVTT
  let body = upstream.body;
  let pct = upstream.headers.get("content-type");
  if (ct && !MEDIA_OK.some((t) => ct.includes(t))) {
    // Type annoncé inconnu : on regarde les octets. Un vrai segment est servi
    // sous SON type (jamais sous l'étiquette du CDN, qui pourrait être
    // text/html) ; tout le reste est refusé, en nommant le type (voir le
    // workflow proxy-probe).
    const p = await peek(upstream.body);
    const vrai = sniffMedia(p.head, path);
    if (!vrai) {
      if (p.rest) p.rest.cancel().catch(() => {});
      return new Response("type de contenu non autorisé: " + ct, { status: 415 });
    }
    body = p.rest;
    pct = vrai;
  }

  const h = new Headers();
  if (pct) h.set("content-type", pct);
  for (const k of ["content-range", "accept-ranges", "content-length"]) {
    const val = upstream.headers.get(k);
    if (val) h.set(k, val);
  }
  h.set("access-control-allow-origin", "*");
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "sandbox");
  // Les segments de média (fMP4/TS) sont immuables une fois produits :
  // on les met en cache sur le CDN Vercel (PoP proche du lecteur) pour
  // éviter un aller-retour jusqu'à Paris à chaque segment → moins de buffering.
  h.set("cache-control", "public, max-age=300, s-maxage=300");
  return new Response(body, { status: upstream.status, headers: h });
}
