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
 */

export const config = { runtime: "edge", regions: ["cdg1"] };

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";
const SELF = "/api/fr?u=";

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
  let target = reqUrl.searchParams.get("u");

  if (id && !target) {
    target = await resolveParaTV(id);
    if (!target) return new Response("id introuvable: " + id, { status: 404 });
  }
  if (!target) return new Response("usage: /api/fr?id=<tvg-id> ou ?u=<url>", { status: 400 });

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
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
