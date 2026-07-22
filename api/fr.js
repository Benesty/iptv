/**
 * Proxy France — Vercel Edge Function épinglée à Paris (cdg1).
 *
 * Débloque les chaînes géo-FR (TF1, France.tv, Canal+…) depuis le Québec :
 * tout le flux (manifeste + segments) est récupéré depuis une IP française
 * puis relayé à ton lecteur.
 *
 * Trois modes :
 *   /api/fr?id=<tvg-id>   -> résout l'URL ParaTV courante PUIS proxifie (1 saut)
 *   /api/fr?dm=<video-id> -> résout le live Dailymotion (CSTAR, T18…) PUIS proxifie
 *                            (&ref=<url> : embedder/Referer pour les lives
 *                            restreints à leur site, ex. T18 -> www.t18.fr ;
 *                            &fb=<url> : repli si la résolution échoue)
 *   /api/fr?u=<url>       -> proxifie une URL directe (France.tv, Canal+, segments…)
 *
 * Le mode dm= existe parce que les stubs ParaTV sourcés Dailymotion
 * (cstar-dm, t18-dm) meurent dès que LEUR résolveur cale : les jetons sec2
 * expirent ~6 h après émission et chaque lecture devient un 502. Ici on
 * demande un jeton frais à Dailymotion à chaque chargement du manifeste.
 */

export const config = { runtime: "edge", regions: ["cdg1"] };

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";
const SELF = "/api/fr?u=";

async function resolveDailymotion(videoId, embedder) {
  let meta;
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
      }
    );
    if (!res.ok) return { error: "metadata http " + res.status };
    meta = await res.json();
  } catch (e) {
    return { error: "metadata fetch: " + e };
  }
  if (meta?.error)
    return {
      error:
        "metadata: " +
        (meta.error.title || meta.error.message || JSON.stringify(meta.error)),
    };
  // Premier flux HLS parmi les qualités — certains lives listent DASH en
  // premier, et un .mpd proxifié brut est illisible pour le lecteur.
  let anyUrl = null;
  for (const arr of Object.values(meta?.qualities || {})) {
    if (!Array.isArray(arr)) continue;
    for (const q of arr) {
      const u = q && typeof q.url === "string" && q.url.startsWith("http") ? q.url : null;
      if (!u) continue;
      anyUrl = anyUrl || u;
      const t = (q.type || "").toLowerCase();
      if (t.includes("mpegurl") || u.includes(".m3u8")) return { url: u };
    }
  }
  if (anyUrl) return { url: anyUrl };
  return { error: "metadata sans flux (onair=" + (meta?.onair ?? "?") + ")" };
}

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
  const dm = reqUrl.searchParams.get("dm");
  let target = reqUrl.searchParams.get("u");

  if (id && !target) {
    target = await resolveParaTV(id);
    if (!target) return new Response("id introuvable: " + id, { status: 404 });
  }
  if (dm && !target) {
    const r = await resolveDailymotion(dm, reqUrl.searchParams.get("ref"));
    if (r.url) {
      target = r.url;
    } else {
      // fb= : URL de repli (ex. stub ParaTV) si la résolution Dailymotion
      // échoue — au pire on retrouve le comportement stub d'avant.
      target = reqUrl.searchParams.get("fb");
      if (!target)
        return new Response(
          "live dailymotion irrésoluble: " + dm + " — " + r.error,
          { status: 502 }
        );
    }
  }
  if (!target)
    return new Response("usage: /api/fr?id=<tvg-id>, ?dm=<video-id> ou ?u=<url>", { status: 400 });

  let upstream;
  try {
    const tOrigin = new URL(target).origin;
    upstream = await fetch(target, {
      headers: {
        "user-agent": "Mozilla/5.0 (SmartTV) AppleWebKit/537.36",
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
