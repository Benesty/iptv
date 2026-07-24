# iptv

Playlist IPTV personnelle (France 🇫🇷 / Canada 🇨🇦 / USA 🇺🇸), lue depuis le Québec.

**Playlist :** `TV.m3u` · **EPG :** branche `epg` → `epg.xml.gz`

---

## Le problème que ce dépôt résout

Deux plaies, traitées chacune par un mécanisme :

| Plaie | Réponse |
|---|---|
| Les chaînes françaises sont **géo-bloquées** hors de France | un proxy hébergé **à Paris** relaie le flux |
| Les flux non-officiels **changent d'URL / meurent** chaque semaine | un **bot** teste et remplace les liens morts tout seul |

---

## Architecture

```
        ton lecteur (Québec)
                 │
    ┌────────────┴─────────────┐
    │                          │
 URL directe            /api/fr  (Vercel Edge, région cdg1 = Paris)
 (CDN ouverts,           │
  Canada/USA)            ├─ ?id=<tvg-id>  → cherche l'URL courante dans ParaTV, puis relaie
                         └─ ?u=<url>      → relaie une URL précise
                                             (segments et clés repassent par ici,
                                              réécrits dans le manifeste)
```

Pourquoi certaines chaînes ne passent **pas** par le proxy : les CDN « pools »
(`151.80.18.177`, `145.239.5.177`, `99.27.51.147`) et Dailymotion **bloquent les IP
de datacenter**. Les proxifier renvoie 502 ; en accès direct depuis une connexion
résidentielle, elles marchent. D'où le mélange volontaire d'URL directes et proxifiées.

## Sécurité du proxy

Le dépôt est public, donc l'URL du proxy l'est aussi. Trois protections dans `api/fr.js` :

1. **anti-SSRF** — `http(s)` uniquement ; IP privées, loopback, lien-local et
   métadonnées cloud (`169.254.169.254`) refusées ;
2. **allowlist, en refus par défaut** — seuls les 8 domaines réellement traversés
   par les chaînes sont acceptés (relevés par le workflow `collect-hosts`) ;
   tout le reste reçoit `403`, ce qui interdit l'usage en relais anonyme ;
3. **signature HMAC** *(optionnelle)* — les URL de variantes/segments/clés que le
   proxy génère peuvent être signées, ce qui autorise n'importe quel CDN sans
   rouvrir le proxy.

> ℹ️ Aucune configuration n'est nécessaire : la protection 2 suffit et est active.
> La 3 s'ajoute si tu définis `PROXY_SECRET` dans Vercel (Settings → Environment
> Variables, une longue chaîne aléatoire) — utile seulement pour encaisser sans
> rien casser le jour où un CDN change de domaine.

> ⚠️ Si une chaîne renvoie `403 hôte non autorisé: <domaine>`, c'est que son CDN a
> bougé : relance le workflow `collect-hosts` et ajoute le domaine à `ALLOW_HOSTS`
> dans `api/fr.js`.

Le proxy ne renvoie que du média (liste blanche de `content-type`, `nosniff`,
`CSP: sandbox`) : il ne peut pas servir de HTML/JS arbitraire sous ton domaine.

## Automatismes

| Quoi | Quand | Fichier |
|---|---|---|
| **Auto-réparation** — teste chaque flux, remplace les morts, committe | toutes les 3 h | `.github/workflows/heal.yml` → `scripts/heal.py` |
| **EPG** — fusionne les guides et publie sur la branche `epg` | quotidien + à chaque modif de `TV.m3u` | `.github/workflows/epg.yml` → `scripts/build_epg.py` |
| **Test des liens** | à chaque push | `.github/workflows/check-links.yml` |
| **Vérification complète** (chaînes + sécurité) | manuel | `.github/workflows/verify.yml` |

### Comment le bot évite les fausses réparations

- test **profond** : master → variante → **premier segment vidéo**
  (tester le manifeste seul déclarait vivants des flux dont la vidéo est morte) ;
- **re-test 60 s après** avant de condamner (ces flux ont des micro-coupures) ;
- garde-fou **anti-mauvaise-chaîne** (`same_channel`) : refuse un remplaçant dont le
  libellé désigne une autre chaîne — cas réel : un agrégateur publiait un `tvg-id`
  `Cherie25.fr` dont le flux était en fait *RMC Life* ;
- **assertion d'unicité** : si deux chaînes visaient la même ligne, il n'écrit rien.

## Conventions de `TV.m3u`

- Une chaîne sans source valable est **commentée**, jamais supprimée, avec la raison
  et la date — décommenter suffit à la réactiver.
- `# ALT <chaîne> …` = URL de secours vérifiée ; décommente-la si la principale meurt.
- **Pas d'EPG plutôt qu'un faux EPG** : si le flux ne correspond pas à la chaîne
  annoncée, on retire le `tvg-id` et on renomme d'après ce qui est réellement diffusé.

## Limites connues

Certaines chaînes n'ont **aucune** source libre exploitable, ce n'est pas un bug :

- **W9** — DRM Widevine/PlayReady sur M6+, et géo-FR de surcroît ;
- **Teletoon+, Foot+** — payantes, aucun restream vivant ;
- **Chérie 25** — l'identifiant du flux officiel NRJ a changé ; attention, la seule
  source « qui joue » chez les agrégateurs est en réalité *RMC Life* mal étiquetée ;
- **Télé-Québec** — DRM Widevine confirmé côté Brightcove ;
- **T18** — source Dailymotion à jetons expirants, refusée aux IP de datacenter.

## Utilisation manuelle

```bash
python3 scripts/heal.py --dry-run   # rapport, sans rien modifier
python3 scripts/heal.py             # répare et écrit TV.m3u
./check_links.sh -n                 # test local (depuis TON réseau : les flux
                                    # géo-bloqués ne répondent qu'à ta zone)
```
