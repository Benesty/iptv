/**
 * Serveur de dev local pour /deals — évite d'avoir à déployer pour tester.
 *
 *   node scripts/dev_deals.mjs         -> http://localhost:3000/deals
 *   node scripts/dev_deals.mjs 8080    -> autre port
 *
 * Reproduit ce que fait Vercel : le statique de `deals/` d'un côté, la fonction
 * `api/deals.js` de l'autre. La fonction est en Edge Runtime (Request/Response
 * du standard Web) ; Node >= 18 fournit ces globales, il suffit de convertir la
 * requête node:http en Request et la Response en réponse node:http.
 *
 * Contrairement au déploiement, les appels à RedFlagDeals partent d'ici : c'est
 * donc le vrai test de bout en bout, avec les vraies données.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 3000;

const { default: dealsHandler } = await import(join(ROOT, "api", "deals.js"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const started = Date.now();

  try {
    if (url.pathname === "/api/deals") {
      const out = await dealsHandler(new Request(url.href, { method: req.method }));
      const body = Buffer.from(await out.arrayBuffer());
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(body);
      console.log(`${out.status} ${url.pathname}${url.search} — ${Date.now() - started} ms`);
      return;
    }

    // « / » et « /deals » servent la page ; le reste est un fichier de deals/.
    let rel = url.pathname === "/" || url.pathname === "/deals" || url.pathname === "/deals/"
      ? "deals/index.html"
      : url.pathname.replace(/^\//, "");

    // Empêche « ../../etc/passwd » de sortir du dépôt.
    const file = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("interdit");
      return;
    }

    const data = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" });
    res.end(data);
    console.log(`200 ${url.pathname} — ${Date.now() - started} ms`);
  } catch (e) {
    const notFound = e && e.code === "ENOENT";
    res.writeHead(notFound ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(notFound ? "404" : `500 ${e}`);
    console.log(`${notFound ? 404 : 500} ${url.pathname} — ${e.message || e}`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Site   http://localhost:${PORT}/deals`);
  console.log(`  API    http://localhost:${PORT}/api/deals?sort=hot`);
  console.log(`  Debug  http://localhost:${PORT}/api/deals?debug=1\n`);
});
