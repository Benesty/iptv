# ParaTV resolver — déploiement (2 minutes, gratuit)

ParaTV change ses URLs de flux toutes les ~heures. Ce petit worker donne une
**URL stable par chaîne** qui redirige toujours vers l'URL ParaTV à jour →
TF1/TMC/TFX/LCI/TF1 Séries Films ne meurent plus jamais.

## Option A — Dashboard Cloudflare (sans rien installer)

1. Crée un compte gratuit sur https://dash.cloudflare.com (si pas déjà fait).
2. Menu **Workers & Pages** → **Create application** → **Create Worker**.
3. Donne un nom (ex. `paratv`) → **Deploy**.
4. Clique **Edit code**, efface tout, colle le contenu de [`worker.js`](./worker.js) → **Deploy**.
5. Ton URL stable est affichée, du type : `https://paratv.TON-COMPTE.workers.dev`

Teste dans le navigateur : `https://paratv.TON-COMPTE.workers.dev/TF1.fr`
→ ça doit lancer le flux TF1 (ou rediriger vers un .m3u8).

## Option Vercel (tu as Vercel Pro) — recommandé pour toi

La fonction est déjà dans le repo : [`/api/[channel].js`](../api/%5Bchannel%5D.js) (Edge Function).

1. https://vercel.com/new → **Import** le repo `benesty/iptv`.
2. Laisse tout par défaut → **Deploy** (zéro config, Vercel détecte `/api`).
3. Ton URL : `https://<projet>.vercel.app/api/TF1.fr`

Comme le repo est connecté, chaque push redéploie tout seul. (CLI : `vercel --prod`.)

Teste : `https://<projet>.vercel.app/api/TF1.fr` → doit lancer TF1.

## Option B — Cloudflare CLI (si tu as Node)

```bash
npm i -g wrangler
wrangler login
cd cloudflare-worker
wrangler deploy
```

## Ensuite

Donne-moi ton URL (`https://paratv.xxx.workers.dev`) et je remplace les 5 lignes
TF1/TMC/TFX/LCI/TF1 Séries Films dans `TV.m3u` par :

```
https://paratv.xxx.workers.dev/TF1.fr
https://paratv.xxx.workers.dev/TMC.fr
https://paratv.xxx.workers.dev/NT1.fr
https://paratv.xxx.workers.dev/LCI.fr
https://paratv.xxx.workers.dev/TF1SeriesFilms.fr
```

À partir de là, l'auto-réparation horaire devient même inutile pour ces chaînes :
la résolution est faite en direct à chaque lecture.

> Note : le worker marche pour **toute** chaîne de la playlist ParaTV — le chemin
> est simplement son `tvg-id` (ex. `/CanalPlus.fr`, `/CNews.fr`).
