/**
 * Proxy netplus — à faire tourner sur un VPS SUISSE (IP CH).
 *
 * Pourquoi : netplus.ch n'autorise que les IP suisses. Vercel n'a pas de
 * région CH, donc ce petit serveur tourne sur un VPS suisse et relaie les
 * flux netplus (manifeste + segments) à ton lecteur — débloqué, sans DRM,
 * sans lag.
 *
 * Node 18+ requis (fetch intégré). Aucune dépendance npm.
 *
 *   PORT=8080 node server.js
 *
 * Endpoints :
 *   /ch/<slug>      -> chaîne netplus (ex: /ch/canalj, /ch/m6hd, /ch/gulli)
 *   /?u=<url>       -> n'importe quelle URL HLS (encodée)
 *   /healthz        -> "ok"
 *
 * Option sécurité : si la variable d'env KEY est définie, il faut ajouter
 *   &k=<KEY>  (ou /ch/<slug>?k=<KEY>) sinon 403. Évite que d'autres
 *   utilisent ton proxy.
 */

const http = require("http");

const PORT = process.env.PORT || 8080;
const KEY = process.env.KEY || "";
const NETPLUS = (slug) =>
  `https://viamotionhsi.netplus.ch/live/eds/${slug}/browser-HLS8/${slug}.m3u8`;

function rewriteManifest(text, baseUrl, selfBase) {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          const abs = new URL(u, baseUrl).href;
          return `URI="${selfBase}/?u=${encodeURIComponent(abs)}"`;
        });
      }
      const abs = new URL(t, baseUrl).href;
      return `${selfBase}/?u=${encodeURIComponent(abs)}`;
    })
    .join("\n");
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const selfBase = `http://${req.headers.host}`;

    if (u.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }

    if (KEY && u.searchParams.get("k") !== KEY) {
      res.writeHead(403);
      return res.end("forbidden");
    }

    let target = u.searchParams.get("u");
    const m = u.pathname.match(/^\/ch\/([A-Za-z0-9_-]+)/);
    if (m) target = NETPLUS(m[1]);
    if (!target) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("usage: /ch/<slug>  ou  /?u=<url>");
    }

    const tOrigin = new URL(target).origin;
    const up = await fetch(target, {
      headers: {
        "user-agent": "Mozilla/5.0 (SmartTV) AppleWebKit/537.36",
        referer: tOrigin + "/",
        origin: tOrigin,
      },
      redirect: "follow",
    });
    if (!up.ok) {
      res.writeHead(502);
      return res.end("upstream " + up.status);
    }

    const ct = (up.headers.get("content-type") || "").toLowerCase();
    const isM3U8 =
      (up.url || target).toLowerCase().includes(".m3u8") || ct.includes("mpegurl");

    if (isM3U8) {
      const txt = await up.text();
      const out = rewriteManifest(txt, up.url || target, selfBase);
      res.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
      });
      return res.end(out);
    }

    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      "content-type": up.headers.get("content-type") || "application/octet-stream",
      "access-control-allow-origin": "*",
    });
    return res.end(buf);
  } catch (e) {
    res.writeHead(502);
    res.end("error: " + (e && e.message ? e.message : e));
  }
});

server.listen(PORT, () => console.log("netplus proxy on :" + PORT));
