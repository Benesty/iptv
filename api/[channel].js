/**
 * ParaTV resolver — Vercel Edge Function
 *
 * URL stable par chaîne : /api/<tvg-id>
 * À chaque appel, va chercher l'URL ParaTV ACTUELLE et redirige dessus (302).
 * Donc TF1/TMC/TFX/LCI/TF1 Séries Films ne meurent plus jamais malgré la
 * rotation des URLs ParaTV.
 *
 * Exemples :
 *   https://<projet>.vercel.app/api/TF1.fr
 *   https://<projet>.vercel.app/api/TMC.fr
 *   https://<projet>.vercel.app/api/NT1.fr             (TFX)
 *   https://<projet>.vercel.app/api/LCI.fr
 *   https://<projet>.vercel.app/api/TF1SeriesFilms.fr
 */

export const config = { runtime: "edge" };

const PLAYLIST =
  "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u";

export default async function handler(req) {
  const id = decodeURIComponent(
    new URL(req.url).pathname.split("/").pop() || ""
  ).trim();

  if (!id) {
    return new Response("ParaTV resolver OK — usage: /api/<tvg-id>", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Playlist amont mise en cache 60 s (léger, toujours frais).
  const res = await fetch(PLAYLIST, { headers: { "cache-control": "max-age=60" } });
  if (!res.ok) return new Response("playlist amont indisponible", { status: 502 });

  const lines = (await res.text()).split("\n");
  const needle = `tvg-id="${id}"`;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("#EXTINF") && lines[i].includes(needle)) {
      const url = lines[i + 1].trim();
      if (url.startsWith("http")) return Response.redirect(url, 302);
    }
  }
  return new Response(`chaîne introuvable: ${id}`, { status: 404 });
}
