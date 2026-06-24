/**
 * ParaTV resolver — Cloudflare Worker (gratuit)
 *
 * Problème résolu : ParaTV renomme ses URLs de flux toutes les ~heures, donc
 * une URL figée dans TV.m3u meurt vite. Ce worker expose une URL STABLE par
 * chaîne ; à chaque lecture il va chercher l'URL ParaTV ACTUELLE et redirige
 * dessus. Plus jamais de lien mort sur TF1/TMC/TFX/LCI/TF1 Séries Films.
 *
 * Usage dans TV.m3u :
 *   https://<ton-worker>.workers.dev/TF1.fr
 *   https://<ton-worker>.workers.dev/TMC.fr
 *   https://<ton-worker>.workers.dev/NT1.fr            (TFX)
 *   https://<ton-worker>.workers.dev/LCI.fr
 *   https://<ton-worker>.workers.dev/TF1SeriesFilms.fr
 *
 * Le chemin = le tvg-id ParaTV de la chaîne. Marche pour N'IMPORTE quelle
 * chaîne présente dans la playlist ParaTV, pas seulement le groupe TF1.
 */

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";

export default {
  async fetch(request) {
    const id = decodeURIComponent(new URL(request.url).pathname.slice(1)).trim();
    if (!id) {
      return new Response(
        "ParaTV resolver OK. Usage : /<tvg-id>  ex: /TF1.fr",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // Playlist mise en cache 60 s côté Cloudflare (léger, toujours frais).
    const res = await fetch(PLAYLIST, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!res.ok) return new Response("playlist amont indisponible", { status: 502 });

    const lines = (await res.text()).split("\n");
    const needle = `tvg-id="${id}"`;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith("#EXTINF") && lines[i].includes(needle)) {
        const url = lines[i + 1].trim();
        if (url.startsWith("http")) {
          // 302 -> le lecteur suit vers l'URL ParaTV courante.
          return Response.redirect(url, 302);
        }
      }
    }
    return new Response(`chaîne introuvable: ${id}`, { status: 404 });
  },
};
