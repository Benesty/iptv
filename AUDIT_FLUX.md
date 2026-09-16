# Audit des flux — 16 septembre 2026

Périmètre : les **99 chaînes actives** du commit `b9ea52d80b648d5a48b545157c8aba775d67799e`, avant les corrections ci-dessous. Les anciennes chaînes déjà commentées sont exclues.

Chaque URL a été testée jusqu’à un segment vidéo décodable, avec lecture des codecs et comparaison de la progression HLS. Les variantes les plus élevées publiées ont été recherchées dans iptv-org FR/CA/US, ParaTV, schumijo et les pages des éditeurs ; **25 URL alternatives distinctes** ont été sondées.

## Changements retenus

| Chaîne | Avant | Après | Origine |
|---|---|---|---|
| BFM TV | 540p25 | **1080p25** | Distribution officielle Samsung TV Plus ; redirecteur jmp2 |
| T18 | 480p50 | **1080p50** | Dailymotion de T18, résolu via ParaTV et le proxy existant |
| Gulli | Pool tiers, 576i | **CDN officiel M6/Bedrock, 576p25** | Accès direct ; reste en SD |
| Fox Sports 1 US | 720p59,94 | **Flux encodé en 1080p59,94** | Tiers ; un éventuel agrandissement du 720p ne peut pas être exclu |

Les quatre remplacements ont passé deux contrôles de vidéo et de progression. La piste française séparée de Gulli a aussi été téléchargée et décodée (AAC, stéréo). Les anciens flux restent en ALT et dans le registre du bot. Les noms et identifiants EPG de ces quatre chaînes sont inchangés.

**History désactivée, entrée conservée en commentaire** : son URL Cloudflare montre « His Glory », avec Bill Federer, sur deux captures espacées. Ce faux lien est exclu des remplacements automatiques. Le candidat 212.5.144.156 montre bien History en 1080p HEVC, mais ne présente aucune piste audio dans le maître ni le segment examiné ; le candidat Ayna répond 404. Aucun remplacement complet retenu. La playlist compte donc **98 chaînes actives**.

## Flux non confirmés

Après une seconde tentative : **RTL9, CBC Montréal, CBC News Network, Comedy Central US et ESPNews US : HTTP 404 ; M6 Music : HTTP 403**. Ces six entrées restent conservées : un échec depuis cette sonde ne démontre pas leur indisponibilité depuis une connexion résidentielle au Québec. Aucun remplacement satisfaisant trouvé.

Les autres 93 URL initiales livrent une vidéo décodable et des segments qui avancent, mais ce total technique incluait le faux History. Les pauses publicitaires ne constituent pas une preuve de programmation continue. Aucun test ne garantit le fonctionnement futur ou 24 h/24.

## Relevé complet

Résolution mesurée dans un segment, pas déduite du nom « HD ». `i` : entrelacé ; `p` : progressif. L’origine décrit la provenance technique identifiée ; elle ne certifie pas les droits de redistribution hors du service ou du territoire de l’éditeur.

| Chaîne | Mesure initiale | Provenance initiale | Décision / résultat |
|---|---|---|---|
| TF1 | 1280×720 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| France 2 | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| France 3 | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| France 4 | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| France 5 | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| M6 | 1440×1080 i / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Arte | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| W9 | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| TMC | 1280×720 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| TFX | 1280×720 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| GULLI | 720×576 i / h264 | Tiers non authentifié | Remplacé → 1024×576 p / h264 |
| LCI | 1280×720 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| CNews | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| CSTAR | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| 6TER | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| RMC Story | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| RMC Découverte | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| RMC Life | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| TF1 Séries Films | 1280×720 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| CANAL+ | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| France TV Docs | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| France TV Séries | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| BFM TV | 960×540 p / h264 | Éditeur via résolveur/proxy | Remplacé → 1920×1080 p / h264 |
| France 24 (FR) | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| TV5Monde Info | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| TV5Monde+ Voyage | 1280×720 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Canal J | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Planète+ | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| TCM Cinéma | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| 13ème Rue | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Eurosport 1 | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Eurosport 2 | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Comédie+ | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Histoire TV | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| CANAL+ Sport | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Discovery | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| AB1 | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| RTL9 | Non mesurée | Tiers non authentifié | Non confirmé : HTTP 404 |
| franceinfo | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| LCP - Public Sénat | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| France TV Sport | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| T18 | 848×480 p / h264 | Éditeur via résolveur/proxy | Remplacé → 1920×1080 p / h264 |
| La Chaîne L'Équipe | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Novo 19 | 1920×1080 p / h264 | Éditeur via résolveur/proxy | Conservé ; lecture et progression confirmées |
| Paris Première | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Nickelodeon | 896×504 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Nickelodeon Junior | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Disney Junior | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Teva | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Ciné+ Émotion | 896×504 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| M6 Music | Non mesurée | Tiers non authentifié | Non confirmé : HTTP 403 |
| ICI Télé Estrie | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| Radio-Canada Jeunesse | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| Radio-Canada INFO | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Noovo Cinéma | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Noovo Comédies | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Noovo Crime | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| ICI RDI | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| TVA | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| LCN | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| Savoir Média | 640×360 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| ICI Télé Québec | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| L'Agent Jean! | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| CBC News Network | Non mesurée | CDN de l’éditeur | Non confirmé : HTTP 404 |
| CBC Montréal | Non mesurée | CDN de l’éditeur | Non confirmé : HTTP 404 |
| CBC News Explore | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| CBC News Montréal | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| CBC Kids | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| CBC Comedy | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| CTV News | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Global News Montréal | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| CityNews Edmonton | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| Bloomberg TV | 1920×1080 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| Gusto TV | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| Knowledge Network | 1280×720 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| CBS News 24/7 | 1280×720 p / h264 | CDN de l’éditeur | Conservé ; lecture et progression confirmées |
| CNN Headlines International | 1920×1080 p / h264 | Éditeur / distributeur, CDN | Conservé ; lecture et progression confirmées |
| History | 1920×1080 p / h264 | Tiers non authentifié | Désactivé : autre chaîne (His Glory) |
| National Geographic | 1280×720 p / mpeg2video | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Nat Geo Wild | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Cartoon Network US | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Disney Channel US | 1280×720 p / hevc | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Disney Junior US | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| USA Network US | 1920×1080 i / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Bravo US | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| AMC US | 1280×720 p / mpeg2video | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Comedy Central US | Non mesurée | Tiers non authentifié | Non confirmé : HTTP 404 |
| Food Network US | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Animal Planet US | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| SYFY US | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Paramount Network US | 1920×1080 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Lifetime US | 1280×720 p / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| A&E US | 1280×720 p / mpeg2video | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| ABC Miami US | 1920×1080 i / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| CBS Miami US | 1920×1080 i / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| NBC Miami US | 1920×1080 i / h264 | Tiers non authentifié | Conservé ; lecture et progression confirmées |
| Fox Sports 1 US | 1280×720 p / h264 | Tiers non authentifié | Remplacé → 1920×1080 p / h264 |
| ESPNews US | Non mesurée | Tiers non authentifié | Non confirmé : HTTP 404 |
| Nickelodeon US | 1280×720 p / mpeg2video | Tiers non authentifié | Conservé ; lecture et progression confirmées |

## Limites et pistes écartées

- BFM/SFR direct répond 452 ; la distribution Samsung fonctionne en 1080p. Le premier accès au redirecteur a expiré, puis deux tests complets ont réussi.
- Gulli officiel fonctionne maintenant en direct, contrairement aux anciens essais via le proxy. W9 officiel répond toujours 403 ici. Aucun assouplissement des protections du proxy.
- ICI Télé Québec : le maître complet reste en 720p, comme le lien actuel. Les chaînes Radio-Canada/CBC FAST et les trois Noovo sont déjà en 1080p dans les segments examinés.
- Savoir Média reste en 360p ; Nickelodeon FR et Ciné+ Émotion en 504p. Aucun meilleur remplacement complet validé. Les autres pistes américaines sont en erreur, de qualité équivalente ou concernent une autre version territoriale.
- Le 1080i des stations de Miami et de USA Network n’est pas présenté comme du 1080p. Les flux MPEG-2 et HEVC conservés peuvent dépendre des capacités du lecteur.
- CNews a été revérifiée avec son manifeste DVR complet : le plafond initial de lecture tronquait le document et créait un faux soupçon de gel. Le direct avance bien. AB1 et TCM Cinéma avancent aussi au contrôle prolongé.
- Le flux FS1 retenu est déjà présent dans la [playlist iptv-org du 8 septembre 2026](https://github.com/iptv-org/iptv/blob/1ed34721b6345626769b695fe2d374bcfd615198/streams/us.m3u). Cela prouve son ancienneté de publication, pas une disponibilité ininterrompue.
- Les URL temporaires signées et captures de programmes ne sont pas publiées dans ce rapport. Aucun abonnement, identifiant tiers ou contournement DRM utilisé.

## Sources de comparaison

- [Partenariat officiel BFM / Samsung TV Plus](https://www.rmcbfm-ads.com/actualites/altice-media-samsung-tv-plus-partenariat.html) ; [confirmation Samsung](https://news.samsung.com/fr/samsung-tv-plus-juillet).
- [Direct officiel T18](https://t18.fr/direct) ; [compte Dailymotion T18](https://www.dailymotion.com/user/t18).
- [Direct officiel Gulli sur M6+](https://www.m6.fr/gulli/direct) ; [Savoir Média](https://savoir.media/).
- [iptv-org](https://github.com/iptv-org/iptv/tree/master/streams), [ParaTV](https://github.com/Paradise-91/ParaTV), [schumijo](https://github.com/schumijo/iptv). Les libellés et résolutions de ces catalogues ont été confrontés aux segments réellement reçus.
