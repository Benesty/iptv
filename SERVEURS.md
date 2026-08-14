# Serveurs de flux francophones (France / Canada)

Registre des **serveurs** qui hébergent des chaînes FR/QC, pour savoir où
chercher quand une chaîne meurt. Établi le 2026-08-14 en regroupant *par hôte*
les playlists agrégatrices (iptv-org `fra`/`fr`/`ca`, ParaTV, schumijo, Free-TV),
puis en testant un échantillon de chaque serveur depuis un runner GitHub (US).

**Statuts** — `JOUE` : lisible même hors zone · `GÉO-CA/FR` : 403 depuis les
États-Unis, donc réservé à sa zone (doit marcher depuis le Québec pour CA)
· `MORT` : injoignable.

> L'Afrique francophone est volontairement exclue de ce relevé.

## Serveurs « pool » (une IP, plusieurs chaînes)

Ce sont eux qui portent les chaînes commerciales absentes des CDN officiels.
Ils bloquent les IP de datacenter : à utiliser en **accès direct**, jamais via
le proxy Vercel (voir README).

| Serveur | Zone | Statut | Chaînes connues | Utilisé par `TV.m3u` |
|---|---|---|---|---|
| `145.239.5.177` | FR | JOUE | ~24 (6ter, AB1, Arte, CStar, Ciné+, LCI, M6 Music, RMC Life, RTL9, Série Club, Teva, TFX, TV Breizh…) | oui, largement |
| `151.80.18.177:86` | FR | JOUE | Canal+ Cinéma, Disney Jr, Nickelodeon Jr, TF1, TMC | oui |
| `99.27.51.147:8080` | FR | JOUE | M6, Gulli, MTV, SYFY, CinéFrisson | oui |
| `185.246.209.113` | **CA** | **GÉO-CA** | CHCH-DT, Cottage Life, CTV Life Channel, T+E — et **rien d'autre** : 20 chemins sondés (TSN*, W_NETWORK, SLICE, MUCH, HGTV, SPORTSNET, HISTORY…) renvoient tous 404 | non |
| `23.133.220.149` | CA | JOUE | TV5 Québec Canada, Unis TV | non |
| `5.180.164.197:8080` | FR | JOUE | France 3 Lorraine, TV5Monde Europe | non |
| `89.187.185.76:8080` | FR | JOUE | France 3 Côte d'Azur | non |
| `89.33.29.118` | FR | JOUE | MCM Top | non |
| `194.163.157.137:8080` | FR | JOUE | TV Alsace, TV Mulhouse | non |
| `40.160.24.53` / `.55` | CA | **MORT** | ex-TSN 1-5, W Network, Slice, Much, Home Network | retiré le 2026-08-14 |
| `206.212.244.63` | US/CA | **MORT** | ex-Disney US, Super Channel Vault | retiré le 2026-08-14 |
| `176.65.146.100:8047` | FR | MORT | France 4 | non |

## CDN et plateformes (par éditeur)

| Hôte | Zone | Statut | Ce qu'on y trouve |
|---|---|---|---|
| `rcavlive.akamaized.net` | CA | GÉO-CA | ~26 déclinaisons régionales d'ICI Radio-Canada Télé |
| `cbcrclinear-tor.akamaized.net` | CA | GÉO-CA | ~14 stations CBC régionales |
| `amagi-streams.akamaized.net` | CA | GÉO-CA | canaux FAST Radio-Canada/CBC (Jeunesse, Explore, Kids…) |
| `lotus.stingray.com` | CA | JOUE | ~25 chaînes Stingray (Montréal) : Classica, Qello, Classic Rock… |
| `tvalive.akamaized.net` | CA | GÉO-CA | TVA, LCN |
| `citynewsregional.akamaized.net` | CA | JOUE | CityNews (déclinaisons régionales) |
| `ott.tv5monde.com` | FR | GÉO | ~15 flux TV5Monde (Info, FBS, TiVi5…) |
| `ncdn-live-bfm.pfd.sfr.net` | FR | — | famille BFM (le plus gros hôte FR des agrégateurs) |
| `.ftven.fr` / `.tf1.fr` / `.canalplus-cdn.net` | FR | GÉO-FR | CDN officiels France TV / TF1 / Canal+ (via le proxy) |
| `cdn-ue1-prod.tsv2.amagi.tv` | FR | partiel | MyZen TV (JOUE), Museum TV (mort) |
| `event.vedge.infomaniak.com` | FR | JOUE | Génération TV, Puissance TV (petites chaînes) |
| `live.creacast.com` | FR | partiel | ILTV, Littoral FM, CNA (locales) |
| `edge-fast3.evrideo.tv` | FR | JOUE | FashionTV Paris |
| `streamtv.cdn.dvmr.fr` | FR | MORT | ex-TV78, TVR Bretagne (locales) |
| `streamer01.myvideoplace.tv` | FR | MORT | ex-réseau vià (viàOccitanie, TV Vendée) |
| `jmp2.uk` | — | JOUE | **redirecteur** Samsung TV+ / Pluto — pas un serveur : se répare seul |

## Comment s'en servir

1. **Une chaîne meurt** → chercher son nom dans la colonne « chaînes connues »
   d'un pool vivant, ou tester le même chemin sur un autre pool (les chemins se
   ressemblent d'un pool à l'autre : `/M6/index.m3u8`, `/315/index.m3u8`).
2. **Ajouter un pool au bot** : `scripts/heal.py` → `REGISTRY[<tvg-id>]`, liste
   d'URLs de secours essayées en premier. Le bot valide avant d'écrire.
3. **Re-tester un lot d'URLs** : les mettre dans `candidates.json` puis lancer
   le workflow `test-candidates` (il classe JOUE / GÉO / DRM / MORT).
4. **Refaire ce relevé** : `scripts/discover_hosts.py` regroupe les agrégateurs
   par hôte et signale ceux qui sont absents de `TV.m3u`.

> ⚠️ Un serveur vivant aujourd'hui peut mourir en bloc demain — c'est ce qui est
> arrivé à `40.160.24.x` et `206.212.244.63` le 2026-08-14, emportant 10 chaînes
> d'un coup. D'où l'intérêt de **varier les hôtes** entre chaînes voisines
> plutôt que de tout mettre sur le même pool.

## Fouille GitHub élargie (2026-08-14, 2ᵉ passe)

Les 5 agrégateurs habituels étant épuisés, une seconde recherche a ratissé
GitHub au-delà : ~50 dépôts et gists lus, **6 832 URLs FR/CA** récoltées, puis
diagnostiquées couche par couche par le workflow `diag-hosts`.

**Ce qu'elle a changé :** la conclusion « aucun remplaçant pour le câble
canadien » ci-dessous est **caduque** — des candidats existent, mais ils sont
*indécidables depuis un runner* (voir tableau).

| Hôte | Chaînes visées | Verdict du runner | Ce que ça veut dire |
|---|---|---|---|
| `fl1.moveonjoy.com` | Much, et par déduction TSN 1-5, W_NETWORK, SLICE, HGTV | **TCP filtré** (le DNS résout, la connexion est refusée) | serveur VIVANT qui refuse les IP de datacenter → **à tester depuis le Québec** |
| `fl3` / `fl5.moveonjoy.com` | TSN 1-5, W Network, Disney | DNS-KO | sous-domaines retirés (moveonjoy fait tourner ses `flN`) |
| `167.114.157.40`, `192.99.39.240`, `167.114.101.188`, `167.114.156.30` (OVH Canada, wowza `flu555`) | Slice, HGTV, Super Channel 1-2, Teletoon CA, RDS 2, Vrak, YTV, Treehouse, CHCH | **TCP filtré** | même profil → **à tester depuis le Québec** |
| `s13.tntendirect.com` | W9, Chérie 25, M6, tout le TNT | DNS-KO | le sous-domaine `s13` n'existe plus |
| `cherie25.nrjaudio.fm` | Chérie 25 | DNS-KO | confirme que le CDN officiel NRJ de Chérie 25 est retiré |
| `teleqmmd.mmdlive.lldns.net` | Télé-Québec | DNS-KO | l'ancien CDN Limelight de Télé-Québec est retiré |
| `lbcdn.6cloud.fr`, `origin-live-6play.video.bedrock.tech` | Gulli | HTTP 404 / 502 | serveurs vivants, chemins Gulli périmés |
| `144.217.253.140` | Teletoon+ | HTTP 404 | serveur vivant, chemin `/Teletoon/playlist.m3u8` périmé |

**Écartés volontairement :** les gros « pools » à identifiants intégrés
(`connect.ottplus.biz`, `bestott.net`, `tvservice.pro`, `vip-max.com`,
`x.rprotv.com`… — plus de 4 000 URLs) sont des panneaux Xtream d'abonnements
payants dont les identifiants ont fuité. Ils sont hors sujet ici : ce dépôt
n'assemble que des flux ouverts.

### Les trois outils qui vont avec

- `diag-hosts` (workflow) — sépare **DNS-KO / TCP-KO / TLS / HTTP** au lieu de
  tout classer « mort ». C'est lui qui a révélé que `test-candidates` déclarait
  morts des serveurs simplement filtrés.
- `scripts/test_local.py` — **le seul moyen de trancher** pour les TCP-KO :
  il rejoue le test profond du bot depuis ta connexion résidentielle.
  `python3 scripts/test_local.py` puis renvoie-moi la sortie.
- `scripts/discover_hosts.py` — refait le regroupement par hôte.

## Ce que cette recherche n'a PAS donné

À noter pour ne pas refaire le travail :

- ~~aucun remplaçant pour le câble canadien~~ → **corrigé par la 2ᵉ passe
  ci-dessus** : des pistes existent (`fl1.moveonjoy.com`, pools OVH Canada),
  elles attendent un test depuis le Québec. Le seul pool canadien joignable
  d'un runner (`185.246.209.113`) ne sert, lui, que ses 4 chaînes ;
- **deviner des chemins ne marche pas** sur ces pools : ils ne servent que les
  chemins réellement provisionnés (20/20 sondes en 404) ;
- les pools FR découverts n'apportent **pas de secours utilisable** aux chaînes
  de `TV.m3u` : ils portent des *régionales* (France 3 Lorraine / Côte d'Azur)
  ou des *variantes* (TV5Monde Europe ≠ TV5Monde Info) — les brancher comme
  remplaçants ferait regarder une autre chaîne que celle annoncée, exactement
  ce que le garde-fou `same_channel` du bot est là pour empêcher.
