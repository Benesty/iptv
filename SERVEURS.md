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
| `151.80.18.177:86` | FR | JOUE | Canal+ Cinéma, Disney Jr, Nickelodeon Jr, TF1 (`/TF1_HD/`), TMC (`/TMC/`) — `/LCI_HD/` est en 404 depuis le 2026-09-02 | oui (dont secours du groupe TF1) |
| `99.27.51.147:8080` | FR | JOUE | M6, Gulli, MTV, SYFY, CinéFrisson | oui |
| `185.246.209.113` | **CA** | **GÉO-CA** | CHCH-DT, Cottage Life, CTV Life Channel, T+E — et **rien d'autre** : 20 chemins sondés (TSN*, W_NETWORK, SLICE, MUCH, HGTV, SPORTSNET, HISTORY…) renvoient tous 404 | non |
| `23.133.220.149` | CA | JOUE | TV5 Québec Canada, Unis TV | non |
| `23.237.104.106:8080` | **US** | JOUE | ~40 chaînes câblées US, chemins `USA_<NOM>` (Disney Junior, Nickelodeon, FX, Syfy, Starz, Bloomberg, Comedy Central…) — **Nat Geo Wild** y répond (`/USA_NAT_GEO_WILD/`) alors qu'aucun agrégateur ne la liste ; `/USA_CNN/` et `/USA_NATIONAL_GEOGRAPHIC/` en 404 | oui (Disney Junior US, Nat Geo Wild) |
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

**Résultat : la conclusion « aucun remplaçant pour le câble canadien » est
CONFIRMÉE**, cette fois avec une preuve directe et non plus par absence de
trouvaille. Le cheminement mérite d'être gardé, parce qu'il évite de refaire
trois fois la même erreur :

1. des playlists GitHub annonçaient TSN 1-5, W Network, Much, Slice et HGTV sur
   `moveonjoy` — le nom des chemins (`/TSN_1/index.m3u8`, `/W_NETWORK/…`) étant
   identique à celui de l'ancien pool `40.160.24.x`, la piste semblait excellente ;
2. testées depuis un runner GitHub : tout échouait. Mais le workflow
   `test-candidates` classait ça « MORT » sans distinguer les causes — verdict
   inexploitable ;
3. testées depuis la connexion de l'utilisateur au Québec : `fl1` refuse la
   connexion (80 et 443), les pools OVH sont en timeout, plusieurs nœuds
   présentent un certificat non conforme qui faisait échouer Python à tort ;
4. **preuve finale** — sur `fl2`, la sonde témoin `/CNN/index.m3u8` renvoie
   **403 (géo-bloqué)** : le serveur fonctionne et la convention de chemins est
   la bonne. Or `/TSN_1/`, `/TSN1/`, `/TSN_1_CA/`, `/W_NETWORK/`, `/MUCH/`,
   `/SLICE/`, `/HGTV/` renvoient tous **404** sur ce même serveur.

Donc : moveonjoy est vivant mais **ne porte plus ces chaînes**. Ce n'est ni un
blocage d'IP, ni un problème de nommage — elles ne sont plus provisionnées. Les
playlists GitHub qui les listent encore sont périmées.

| Hôte | Chaînes visées | Verdict final (runner + Québec) | Ce que ça veut dire |
|---|---|---|---|
| `fl2` / `fl12` / `fl31` / `fl41` / `fl51` / `fl61.moveonjoy.com` | TSN, W Network, Much, Slice, HGTV, Disney | **HTTP 404** sur les chaînes CA, **403** sur `/CNN/` | serveur VIVANT, chaînes canadiennes **non provisionnées** → piste close |
| `fl1.moveonjoy.com` | idem | ConnectionRefused sur 80 **et** 443, depuis les deux réseaux | nœud éteint |
| `fl3` / `fl5.moveonjoy.com` | TSN 1-5, W Network, Disney | DNS-KO | sous-domaines retirés (moveonjoy fait tourner ses `flN`) |
| `167.114.157.40`, `192.99.39.240`, `167.114.101.188`, `167.114.156.30` (OVH Canada, wowza `flu555`) | Slice, HGTV, Super Channel 1-2, Teletoon CA, RDS 2, Vrak, YTV, Treehouse, CHCH | **timeout** sur 1935 et 80, depuis les deux réseaux | pool éteint |
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

## Les « stubs » à jetons (groupe TF1, France TV, Canal+) — panne du 2026-09-01

Les chaînes officielles passées par le proxy Paris ne lisent pas un flux mais un
**stub** : un manifeste maître hébergé sur GitHub (`raw.githubusercontent.com`,
dépôt ParaTV) dont chaque variante porte un **jeton à durée limitée** délivré par
le CDN de l'éditeur. Constaté en lisant l'historique git de ParaTV (clone en
lecture seule) après la panne des cinq chaînes TF1 du 2026-09-01 au soir :

| Éditeur | Forme du jeton | Durée | Rafraîchi par ParaTV |
|---|---|---|---|
| TF1 (`alive-*.cdn-0.diff.tf1.fr`) | JWT dans le chemin (`/eyJ….eyJ…./`, champ `exp`) | 4 h | toutes les 1 à 3 h — et le **dossier du stub change toutes les ~3 h, l'ancien est supprimé** |
| France TV (`.ftven.fr`) | segment base64 `exp=…~acl=…~hmac=…` | ~4 h | toutes les heures |
| Canal+ (`.canalplus-cdn.net`) | `__token__exp=…~acl=…` dans le chemin | ~4 h | toutes les heures |

Les jetons étaient valides à chaque commit de la nuit du 1ᵉʳ au 2 : ParaTV n'a
pas lâché. Le défaut était dans le proxy, qui figeait le jeton du moment du zap
dans les liens de variantes : un jeton déjà vieux de 3 h coupait la chaîne une
heure plus tard, et le lecteur ne relit jamais le manifeste maître tout seul.
Depuis le 2026-09-02, `api/fr.js` relit le stub à chaque lecture de playlist
média (« `&v=<n>` ») et bascule sur un secours (« `&fb=` », lu en direct) si le
stub est introuvable, expiré ou refusé par le CDN. Le bot sonde ces chaînes et
leurs secours à chaque passage.

**Secours vérifiés le 2026-09-02** (banc d'essai depuis un runner US) :

| Chaîne | Secours retenu | Autres pistes |
|---|---|---|
| TF1 | `151.80.18.177:86/TF1_HD` (JOUE) | `/TF1/` : 404 |
| TMC | `151.80.18.177:86/TMC` (JOUE) | `/TMC_HD/` : 404 |
| TFX | `145.239.5.177/315` (GÉO depuis les USA) | `151.80…/TFX`, `/TFX_HD` : 404 |
| LCI | `145.239.5.177/368` (GÉO depuis les USA) | stub `pinkisso/mored` `res/26-1/lci1.m3u8` : segments lisibles depuis un runner US mais playlist média **gelée** au test du bot (jeton lié à une autre IP ?) ; `151.80…/LCI_HD` : **404** |
| TF1 Séries Films | **aucun** | 9 chemins de pool en 404, `viamotionhsi.netplus.ch` en timeout / 403 via proxy |

> Un stub ParaTV n'est **jamais** un secours ni un remplaçant en lien direct :
> son adresse change toutes les ~3 h. Le bot les écarte (`est_stub_rotatif`).
> Un stub GitHub tiers (pinkisso) n'est acceptable que s'il prouve que sa
> playlist avance, et seulement en secours : son rythme de rafraîchissement
> n'est pas connu.

## Sources officielles : bilan chaîne par chaîne (2026-09-02)

Question posée : pour chaque chaîne servie par un pool anonyme, existe-t-il un
flux officiel ? Relevé fait en croisant les cinq agrégateurs (ParaTV, schumijo,
Free-TV, iptv-org fr/ca/us) et les tests déjà menés via le proxy Paris.

| Chaîne (source actuelle) | Flux officiel ? | Pourquoi on ne l'utilise pas |
|---|---|---|
| **Bloomberg TV** (restream mongol) | **oui, `bloomberg.com`** | **basculée le 2026-09-02** (flux US ; Europe et Samsung en ALT) |
| M6, W9, 6TER, GULLI, M6 Music | oui, `6cloud.fr` (6play) | géo-FR **et** refus des IP de datacenter : 502 via le proxy Paris (testé le 2026-08-30 sur les 6 flux du groupe). Le CDN netplus (Suisse) est réservé à la Suisse |
| Teva, Paris Première | non | chaînes payantes du groupe M6, aucun flux public |
| Ciné+ Émotion | non | chaîne payante Canal+ |
| AB1, RTL9 | non | payantes (AB / RTL) ; RTL9 n'existe qu'en restream |
| Nickelodeon, Nickelodeon Junior, Disney Junior | non | payantes (Paramount / Disney), aucun flux public FR |
| History, National Geographic | non | payantes (A+E / Disney), seuls des restreams existent |
| Nat Geo Wild | non | idem ; le pool 198.58 ne sert qu'une boucle VOD depuis le 2026-09-01 → **basculée le 2026-09-03** sur le pool 23.237 (trouvée par sondage, voir ci-dessous) |
| Disney Channel US, Disney Junior US | non | idem ; la seule source vivante de Disney Channel US est réservée aux États-Unis |
| CNN | officiel (`warnermediacdn.com`)… **mais c'est une mire** | le chemin `cnn_slate` ne sert qu'une boucle VOD (ENDLIST) depuis le 2026-09-01 ; le direct CNN US exige un abonnement TV. **Basculée le 2026-09-03 sur CNN Headlines International**, canal FAST officiel de CNN (Samsung TV Plus FR, via jmp2) ; CNN Headlines (Pluto US) en ALT |

Règle qui en découle : un pool n'est remplacé par un flux officiel que quand ce
flux existe **et** passe le proxy. Pour le groupe M6, seul 6cloud changerait la
donne ; il faudrait qu'il cesse de bloquer les IP de datacenter.

## Banc d'essai du 2026-09-03 : CNN et Nat Geo Wild

Toutes deux « 💀 VOD/clip (ENDLIST) » depuis le 2026-09-01 sans que le bot
trouve mieux : ses six sources n'offrent qu'une seule URL pour chacune (celle
qui est en panne). 19 sondes lancées via `test-candidates` + `diag-hosts` :

| Piste | Verdict | Conclusion |
|---|---|---|
| `jmp2.uk/stvp-FRBD190001055` — CNN Headlines International (Samsung TV Plus FR) | **JOUE** | **adoptée** : canal FAST officiel de CNN, même mécanique que RMC Life / TV5Monde+ Voyage (EPG Samsung `FRBD190001055`) |
| `jmp2.uk/plu-5421f71da6af422839419cb3` — CNN Headlines (Pluto TV US) | JOUE | en ALT (Pluto US non essayé depuis le Québec) |
| `cnn-cnninternational-1-*.{rakuten,samsung,plex}.wurl.tv` (4 hôtes cités par des playlists GitHub) | **DNS-KO** | les feeds wurl de CNN International n'existent plus |
| `viamotionhsi.netplus.ch/…/cnn` | timeout | réservé à la Suisse, comme le reste de netplus |
| `/cnn/` sur 198.58, 212.5 et `/USA_CNN/` sur 23.237 | 404 | aucun pool US connu ne porte CNN |
| `23.237.104.106:8080/USA_NAT_GEO_WILD/` | **JOUE** | **adoptée** pour Nat Geo Wild (hôte différent de National Geographic, qui reste sur 198.58) |
| `/ngwild/`, `/natgeowild/` sur 198.58 et 212.5 ; `/USA_NATGEO_WILD/`, `/USA_NATIONAL_GEOGRAPHIC_WILD/` sur 23.237 | 404 | — |
| `198.58.104.90:8989/natgeowild/` (l'ancienne) | 200 mais ENDLIST | en ALT, peut revenir |

Nuance à la règle « deviner des chemins ne marche pas » : ça a marché ici parce
que la convention du pool 23.237 (`USA_<NOM_EN_MAJUSCULES>`) est connue par ses
~40 chemins publiés — un seul essai sur trois a répondu, et seulement là. Sur un
pool dont on ne connaît pas la convention, la règle reste vraie.

## Ce que cette recherche n'a PAS donné

À noter pour ne pas refaire le travail :

- **aucun remplaçant pour le câble canadien** (TSN 1-5, W Network, Slice, Much,
  Home Network, Super Channel Vault) — désormais **prouvé** et non plus supposé,
  par la 2ᵉ passe ci-dessus : les agrégateurs pointent sur des IP mortes, le
  dernier réseau crédible (moveonjoy) ne provisionne plus ces chaînes (404 alors
  que `/CNN/` répond), les pools OVH sont éteints, et le seul pool canadien
  joignable (`185.246.209.113`) ne sert que ses 4 chaînes. **Ne pas re-tenter
  sans indice neuf** : ces chaînes sont payantes (Bell/Corus) et n'existaient
  qu'en restream ;
- **deviner des chemins ne marche pas** sur ces pools : ils ne servent que les
  chemins réellement provisionnés (20/20 sondes en 404) ;
- les pools FR découverts n'apportent **pas de secours utilisable** aux chaînes
  de `TV.m3u` : ils portent des *régionales* (France 3 Lorraine / Côte d'Azur)
  ou des *variantes* (TV5Monde Europe ≠ TV5Monde Info) — les brancher comme
  remplaçants ferait regarder une autre chaîne que celle annoncée, exactement
  ce que le garde-fou `same_channel` du bot est là pour empêcher.
