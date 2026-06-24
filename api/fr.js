/**
 * Proxy France — Vercel Edge Function épinglée à Paris (cdg1).
 *
 * But : débloquer les chaînes géo-FR (TF1, M6, France.tv…) depuis le Québec,
 * SANS VPN sur ton appareil. Tout le flux (manifeste + segments) est récupéré
 * depuis une IP française (Vercel Paris) puis relayé à ton lecteur.
 *
 * Usage :  /api/fr?u=<URL encodée du flux>
 * Exemple :/api/fr?u=https%3A%2F%2Fiptv-lake-three.vercel.app%2Fapi%2FTF1.fr
 *
 * NB Pro requis pour épingler la région (regions:['cdg1']).
 */

export const config = { runtime: "edge", regions: ["cdg1"] };

const SELF = "/api/fr?u=";

function rewriteManifest(text, baseUrl, origin) {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // réécrit les URI="..." (audio, sous-titres, clés…)
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          const abs = new URL(u, baseUrl).href;
          return `URI="${origin}${SELF}${encodeURIComponent(abs)}"`;
        });
      }
      // ligne d'URL (segment ou sous-playlist) -> repasse par le proxy
      const abs = new URL(t, baseUrl).href;
      return `${origin}${SELF}${encodeURIComponent(abs)}`;
    })
    .join("\n");
}

export default async function handler(req) {
  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("u");
  if (!target) return new Response("usage: /api/fr?u=<url>", { status: 400 });
  const origin = reqUrl.origin;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { "user-agent": "Mozilla/5.0 (SmartTV) AppleWebKit/537.36" },
      redirect: "follow",
    });
  } catch (e) {
    return new Response("fetch error: " + e, { status: 502 });
  }
  if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502 });

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const isManifest =
    target.toLowerCase().includes(".m3u8") ||
    ct.includes("mpegurl") ||
    ct.includes("application/x-mpegurl");

  if (isManifest) {
    const text = await upstream.text();
    const base = upstream.url || target;
    const out = rewriteManifest(text, base, origin);
    return new Response(out, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
      },
    });
  }

  // segment binaire : relais en streaming
  const h = new Headers();
  const pct = upstream.headers.get("content-type");
  if (pct) h.set("content-type", pct);
  h.set("access-control-allow-origin", "*");
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
