#!/usr/bin/env python3
"""
Auto-réparation de TV.m3u.

Pour chaque chaîne à URL DIRECTE (hors résolveurs auto-réparants), teste le
flux ; si le flux est MORT (pas géo-bloqué), cherche un remplaçant dans un jeu
de playlists agrégatrices maintenues (par tvg-id puis par nom normalisé),
valide le candidat, et remplace l'URL. Écrit TV.m3u ; le workflow committe si
changement (ce qui relance l'EPG + le déploiement).

  python3 scripts/heal.py            # répare + écrit TV.m3u
  python3 scripts/heal.py --dry-run  # rapport seulement, n'écrit rien

Classement d'un flux (depuis un runner US) :
  ok   = manifeste valide + segment lisible + la playlist AVANCE  -> on garde
  geo  = HTTP 403/401 (géo-bloqué CA/FR)         -> on garde (marche chez toi)
  dead = 000/404/timeout/HTML/gelé/VOD/DRM/…     -> on répare

Un remplaçant n'est adopté que s'il passe le test profond PUIS prouve,
LIVE_GAP s plus tard, que sa playlist média avance (validate_candidate) —
l'ancien test unique adoptait des flux gelés ou éphémères, d'où des
« réparations » vers des liens morts.
"""
import re, sys, time, shutil, subprocess, unicodedata
import urllib.request, urllib.error, urllib.parse

TIMEOUT = 15
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
DRY = "--dry-run" in sys.argv

# Résolveurs / redirecteurs qui se réparent seuls : on ne remplace jamais leur
# URL. Depuis le 2026-09-02 on les SONDE quand même (à travers le proxy, comme
# le ferait le lecteur) pour que ETAT.md dise la vérité — la panne TF1 du
# 2026-09-01 au soir était invisible ici : « via proxy (se répare seul) ».
SKIP_HOSTS = ("iptv-lake-three.vercel.app", "jmp2.uk")
PROXY_HOST = "iptv-lake-three.vercel.app"


def fb_of(url):
    """Adresse de secours (&fb=…) portée par un lien proxy, ou None."""
    if PROXY_HOST not in url:
        return None
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    return (q.get("fb") or [None])[0]


def avec_fb(url, fb):
    """Le même lien proxy, avec son &fb= remplacé (ou ajouté)."""
    p = urllib.parse.urlparse(url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
         if k != "fb"] + [("fb", fb)]
    return urllib.parse.urlunparse(p._replace(query=urllib.parse.urlencode(q)))

# CDN OFFICIELS de diffuseurs : un 403 y est un vrai géo-blocage, la chaîne
# marche depuis sa zone. On ne les remplace JAMAIS sur la foi d'un 403.
CDN_OFFICIELS = (
    "akamaized.net", "akamaihd.net", "ftven.fr", "tf1.fr", "canalplus-cdn.net",
    "nextradiotv.com", "6cloud.fr", "bedrock.tech", "france24.com", "tv5monde.com",
    "savoir.media", "cloudfront.net", "corusdigitaldev.com", "cbsnews.com",
    "warnermediacdn.com", "amagi.tv", "mediatailor", "nrjaudio.fm",
)

# Un 403 venant d'un pool de restream anonyme (une IP nue) ne veut PAS dire
# « géo-bloqué mais bon chez toi » : c'est le plus souvent le pool qui a fermé.
# Cas vécu le 2026-08-30 : 6ter répondait 403 au runner et était bel et bien
# morte chez l'utilisateur. Pour ces hôtes-là on cherche donc un remplaçant —
# mais on ne l'adopte que s'il joue VRAIMENT (validate_candidate), sinon on
# garde l'existant : on ne troque jamais un doute contre une certitude de panne.
def hote_officiel(url):
    h = urllib.parse.urlparse(url).hostname or ""
    return any(d in h for d in CDN_OFFICIELS)


# Pools dont le 403 est PROUVÉ injouable depuis le Québec (retour de
# l'utilisateur) : là, 403 = mort, pas « géo-bloqué mais bon chez toi ».
#   145.239.5.177  — Teva, Ciné+ Émotion, M6 Music, Série Club : le 2026-09-02
#                    (et déjà 6ter le 2026-08-30).
#   212.5.144.156  — Disney Channel US : flux réservé aux États-Unis.
#   190.14.10.19   — ancien pool Disney (en réalité Disney Latin America).
POOLS_403_MORTS = ("145.239.5.177", "212.5.144.156", "190.14.10.19")


def pool_403_mort(url):
    h = urllib.parse.urlparse(url).hostname or ""
    return h in POOLS_403_MORTS

# Playlists sources maintenues (agrégateurs FR + CA/US). On y cherche un remplaçant.
# CA/US ajoutés le 2026-08-14 : les pools nord-américains (TSN, Corus, Disney…)
# meurent aussi, et sans source CA/US le bot ne pouvait JAMAIS les réparer.
SOURCES = [
    "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_france.m3u8",
    "https://iptv-org.github.io/iptv/countries/fr.m3u",
    "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u",
    "https://raw.githubusercontent.com/schumijo/iptv/main/fr.m3u8",
    "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ca.m3u",
    "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us.m3u",
]

# Registre de candidats par tvg-id. Les chaînes commerciales/payantes FR (M6,
# 6ter, kids…) ne figurent PAS dans les agrégateurs ci-dessus : leurs seuls flux
# sont des restreams sur des pools d'IP. On garde ici un pool de secours par
# chaîne (validé le 2026-07-17), essayé EN PREMIER quand la chaîne meurt, dans
# l'ordre de préférence. Ajoute-z-en librement : le bot valide avant d'écrire.
REGISTRY = {
    # Groupe TF1 : la chaîne elle-même passe par le proxy (stub ParaTV, jeton
    # relu à chaque lecture). Ces adresses servent de SECOURS (&fb= du lien
    # proxy) : le lecteur y est renvoyé si le stub est introuvable, expiré ou
    # refusé par le CDN. Validées au banc d'essai du 2026-09-02 ; le bot les
    # sonde à chaque passage et remplace un secours mort par le suivant.
    "TF1.fr": ["http://151.80.18.177:86/TF1_HD/index.m3u8"],
    "TMC.fr": ["http://151.80.18.177:86/TMC/index.m3u8"],
    "NT1.fr": ["http://145.239.5.177/315/index.m3u8"],                 # TFX
    "LCI.fr": [
        "http://145.239.5.177/368/index.m3u8",
        # stub GitHub tiers (jeton TF1 rafraîchi par son mainteneur) : ses
        # segments se lisent depuis un runner US, mais sa playlist média n'y
        # AVANCE pas (test de gel du 2026-09-02) — le bot ne l'adoptera que
        # s'il prouve un jour qu'il avance.
        "https://raw.githubusercontent.com/pinkisso/mored/refs/heads/main/res/26-1/lci1.m3u8",
    ],
    # TF1SeriesFilms.fr : aucun secours connu (9 chemins de pool et netplus
    # essayés le 2026-09-02, tous morts ou géo-bloqués).
    # M6 : le flux du pool 99.27.51.147 servait le SON SANS L'IMAGE
    # (signalé le 2026-08-30). Pistes trouvées lors de la fouille GitHub,
    # essayées en premier ; le bot vérifie la présence d'une piste vidéo avant
    # d'en adopter une, donc un flux audio seul ne peut plus être retenu.
    "M6.fr": [
        "https://shls-m6-france-prod-dub.shahid.net/out/v1/c8a9f6e000cd4ebaa4d2fc7d18c15988/index.m3u8",
        "https://144.217.253.140/M6/tracks-v1a1/index.m3u8",
        "http://144.217.253.140/M6/playlist.m3u8",
        "https://sslhls.m6tv.cdn.sfr.net/hls-live/livepkgr/_definst_/m6_hls_aes/m6_hls_aes_856.m3u8",
        "http://cdn.haititivi.com/M6-HD/index.m3u8",
        "http://99.27.51.147:8080/M6/index.m3u8",
    ],
    "6ter.fr": [
        "http://151.80.18.177:86/6ter/index.m3u8",
        "http://145.239.5.177/314/index.m3u8",
    ],
    "Gulli.fr": [
        "https://stream1.freetv.fun/027cd356ec6b03bd62d4ccb17fc487c1dca3fd05bdbec771634fa361772de734.m3u8",
        "http://99.27.51.147:8080/Gulli/index.m3u8",
    ],
    "AB1.fr": [
        "http://151.80.18.177:86/AB1/index.m3u8",
        "http://145.239.5.177/332/index.m3u8",
    ],
    "RTL9.fr": [
        "https://stream1.freetv.fun/2a569fd6415093249fce62ab816170066135e2812d78362b181bcfd75824626d.m3u8",
        "http://cdn.haititivi.com/rtl-9/index.m3u8",
        "http://151.80.18.177:86/RTL9/index.m3u8",
    ],
    "ParisPremiere.fr": [
        "http://151.80.18.177:86/Paris_Premiere_HD/index.m3u8",
        "http://cdn.haititivi.com/PARIS-PREMIERE/index.m3u8",
    ],
    "Nickelodeon.fr": ["http://151.80.18.177:86/Nickelodeon_FR/index.m3u8"],
    "NickelodeonJunior.fr": ["http://151.80.18.177:86/Nickelodeon_Junior/index.m3u8"],
    "DisneyJunior.fr": [
        "http://151.80.18.177:86/Disney_Junior_HD/index.m3u8",
        "http://41.205.77.102/DISNEY-JUNIOR/index.m3u8",
    ],
    "TeletoonPlus.fr": [
        "http://144.217.253.140/Teletoon/tracks-v1a1/index.m3u8",
        "http://cdn.haititivi.com/TELETOON-HD/index.m3u8",
    ],
    "Cherie25.fr": ["https://cherie25.nrjaudio.fm/hls/live/2038375/c25/master.m3u8"],
    # USA — pools validés au banc d'essai du 2026-08-14 (les anciens pools
    # 40.160.24.53 et 206.212.244.63 sont morts en bloc ce jour-là).
    "History.us": [
        "http://212.5.144.156:8080/history/index.m3u8",
        "https://customer-6itfaqopbksp5p0q.cloudflarestream.com/3972e89fb79bf6d6dd2a16c75455087a/manifest/video.m3u8",
    ],
    "NationalGeographic.us": [
        "http://198.58.104.90:8989/natgeo/index.m3u8",
        "http://212.5.144.156:8080/natgeo/index.m3u8",
    ],
    "NatGeoWild.us": ["http://198.58.104.90:8989/natgeowild/index.m3u8"],
    "DisneyChannel.us": [
        "http://190.14.10.19:16000/play/a06z/index.m3u8",
        "http://212.5.144.156/disney/index.m3u8",
    ],
    "DisneyJunior.us": [
        "http://23.237.104.106:8080/USA_DISNEY_JUNIOR/index.m3u8",
        "http://212.5.144.156/disneyjr/index.m3u8",
    ],
}


def http(url, read=0):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    r = urllib.request.urlopen(req, timeout=TIMEOUT)
    data = r.read(read) if read else b""
    return r.status, data.decode("utf-8", "replace")


def http_full(url, rng=None):
    """(status, texte, content-type, url FINALE après redirections).

    L'URL finale est indispensable : c'est la base pour résoudre les URI
    relatives d'un manifeste (sinon on fabrique des liens de segments faux et
    on déclare morts des flux qui marchent).
    """
    headers = {"User-Agent": UA, "Accept": "*/*"}
    if rng:
        headers["Range"] = rng
    req = urllib.request.Request(url, headers=headers)
    r = urllib.request.urlopen(req, timeout=TIMEOUT)
    data = r.read(4000 if rng else 300000)
    return (r.status, data.decode("utf-8", "replace"),
            r.headers.get("Content-Type", ""), r.geturl())


def get_text(url, tries=3):
    last = None
    for n in range(tries):
        try:
            return http(url, read=8_000_000)[1]
        except Exception as e:
            last = e
            time.sleep(2 * (n + 1))
    raise last


def _first_uri(text, base):
    """Première URI non-commentée d'un manifeste, rendue absolue."""
    for ln in text.split("\n"):
        ln = ln.strip()
        if ln and not ln.startswith("#"):
            return urllib.parse.urljoin(base, ln)
    return None


# Attente entre deux lectures de la playlist média pour prouver qu'elle
# AVANCE (segments ~4-10 s : 25 s suffisent à voir bouger la séquence).
LIVE_GAP = 25


def _fingerprint(text):
    """(media-sequence, dernier segment, targetduration) d'une playlist média.

    Les deux premiers identifient l'état du direct : si ni la séquence ni le
    dernier segment ne changent entre deux lectures, le flux est GELÉ.
    """
    seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", text)
    td = re.search(r"#EXT-X-TARGETDURATION:(\d+)", text)
    last = None
    for ln in text.split("\n"):
        ln = ln.strip()
        if ln and not ln.startswith("#"):
            last = ln
    return (seq.group(1) if seq else None, last, int(td.group(1)) if td else None)


VIDEO_CODECS = ("avc1", "avc3", "hvc1", "hev1", "av01", "vp09", "mp4v")
FFPROBE = shutil.which("ffprobe")


def a_de_la_video(url, texte_master=None):
    """Y a-t-il une PISTE VIDÉO ?  True | False | None (indéterminé)

    Cas signalé par l'utilisateur le 2026-08-30 : M6 avait le son mais pas
    l'image. Le test profond validait ce flux sans rien voir, puisqu'un flux
    audio seul sert des segments parfaitement valides. On refuse maintenant.

    ffprobe (installé sur les runners GitHub) donne la réponse certaine ;
    sinon on lit les attributs du master. None = on ne sait pas, et dans le
    doute on ne condamne pas une chaîne.
    """
    if FFPROBE:
        try:
            p = subprocess.run(
                [FFPROBE, "-v", "error", "-select_streams", "v",
                 "-show_entries", "stream=codec_name", "-of", "csv=p=0", url],
                capture_output=True, text=True, timeout=40)
            if (p.stdout or "").strip():
                return True
            if p.returncode == 0:
                return False
        except Exception:
            pass
    if texte_master and "#EXT-X-STREAM-INF" in texte_master:
        for attrs in re.findall(r"#EXT-X-STREAM-INF:([^\n]*)", texte_master):
            if "RESOLUTION=" in attrs:
                return True
            m = re.search(r'CODECS="([^"]*)"', attrs)
            if m and any(c in m.group(1).lower() for c in VIDEO_CODECS):
                return True
        return False
    return None


def probe(url):
    """(status, raison, url_playlist_média, empreinte)  — status: ok|geo|dead

    Test PROFOND : master -> variante -> premier segment vidéo. Un flux dont le
    manifeste répond 200 mais dont les segments sont morts est bien classé
    « dead » (un simple test du manifeste le déclarait vivant à tort, et le bot
    ne réparait donc jamais ce cas — le plus fréquent en pratique).

    Depuis le 2026-08-14, on refuse aussi : les VOD/clips servis à la place
    d'un direct (#EXT-X-ENDLIST — cas réel : le clip « indisponible » de
    ParaTV passait pour un flux vivant) et les manifestes chiffrés (DRM).
    L'empreinte retournée sert au test de gel (voir playlist_progress).
    """
    try:
        st, body, ct, final = http_full(url)
        if st not in (200, 206) or not body.lstrip().startswith("#EXT"):
            return ("dead", f"HTTP {st}, pas un manifeste HLS", None, None)

        master = body
        cur, text = final, body
        # master (plusieurs qualités) -> on descend d'un niveau
        if "#EXT-X-STREAM-INF" in text:
            v = _first_uri(text, cur)
            if not v:
                return ("dead", "master sans variante", None, None)
            st, text, ct, cur = http_full(v)
            if st not in (200, 206) or not text.lstrip().startswith("#EXT"):
                return ("dead", f"variante HTTP {st}", None, None)

        low = text.lower()
        if "#ext-x-endlist" in low:
            return ("dead", "VOD/clip (ENDLIST), pas un direct", None, None)
        if any(k in low for k in ("skd:", "sample-aes", "widevine", "playready")):
            return ("dead", "DRM référencé", None, None)

        seg = _first_uri(text, cur)
        if not seg:
            return ("dead", "playlist sans segment", None, None)
        # Flux chiffré (AES-128) : la clé doit être lisible, sinon le lecteur
        # affiche un écran noir alors que les segments répondent — c'est ainsi
        # que France 2/3/5 sont passées inaperçues le 2026-09-02 (le proxy
        # refusait la clé, les segments passaient).
        cle = re.search(r'#EXT-X-KEY:[^\n]*METHOD=AES-128[^\n]*URI="([^"]+)"', text)
        if cle:
            kreq = urllib.request.Request(urllib.parse.urljoin(cur, cle.group(1)),
                                          headers={"User-Agent": UA, "Accept": "*/*"})
            try:
                kr = urllib.request.urlopen(kreq, timeout=TIMEOUT)
                if kr.status != 200 or len(kr.read(64)) < 16:
                    return ("dead", f"clé AES illisible (HTTP {kr.status})", None, None)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    return ("geo", f"clé HTTP {e.code}", None, None)
                return ("dead", f"clé AES illisible (HTTP {e.code})", None, None)
            except Exception as e:
                return ("dead", f"clé AES illisible ({type(e).__name__})", None, None)
        st, chunk, ct, _ = http_full(seg, rng="bytes=0-2000")
        if st in (200, 206) and len(chunk) > 200 and "html" not in (ct or "").lower():
            # Le son sans l'image est une panne, pas un flux valide.
            if a_de_la_video(url, master) is False:
                return ("dead", "son sans image (aucune piste vidéo)", None, None)
            return ("ok", "", cur, _fingerprint(text))
        return ("dead", f"segment HTTP {st}", None, None)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            if pool_403_mort(url):
                return ("dead", f"HTTP {e.code} sur un pool confirmé injouable depuis le Québec",
                        None, None)
            return ("geo", f"HTTP {e.code}", None, None)
        return ("dead", f"HTTP {e.code}", None, None)
    except Exception as e:
        return ("dead", type(e).__name__, None, None)


def playlist_progress(media_url, fp):
    """La playlist média a-t-elle avancé depuis l'empreinte fp ?

    -> "avance" | "gele" | "inconnu"

    « inconnu » (re-lecture impossible, ou segments plus longs que LIVE_GAP)
    n'est PAS une preuve de gel : on ne condamne une chaîne en place que sur
    un « gele » franc, et on n'adopte un candidat que sur un « avance » franc.
    Cette asymétrie évite les deux erreurs qui coûtent cher : condamner un
    flux vivant (churn de commits) et adopter un flux mort (chaîne en panne
    dans le lecteur alors que le bot dit avoir réparé).
    """
    try:
        st, text, ct, _ = http_full(media_url)
        if st not in (200, 206) or not text.lstrip().startswith("#EXT"):
            return "inconnu"
        if "#ext-x-endlist" in text.lower():
            return "gele"
        seq2, last2, _td2 = _fingerprint(text)
        if (seq2, last2) != (fp[0], fp[1]):
            return "avance"
        td = fp[2]
        if td and td > LIVE_GAP:
            return "inconnu"        # segments trop longs pour juger en LIVE_GAP s
        return "gele"
    except Exception:
        return "inconnu"


def classify(url):
    """ok | geo | dead — test profond SANS le test de gel (compat)."""
    return probe(url)[0]


def validate_candidate(url):
    """Validation RENFORCÉE d'un remplaçant (2026-08-14).

    L'ancien test unique laissait passer trois familles de faux vivants,
    d'où des « réparations » vers des liens morts : les flux qui meurent au
    bout d'une minute, les flux gelés, et les clips VOD. On exige maintenant
    un test profond OK **puis**, LIVE_GAP s plus tard, la preuve que la
    playlist média avance réellement.
    """
    st, _reason, media, fp = probe(url)
    if st != "ok":
        return False
    time.sleep(LIVE_GAP)
    return playlist_progress(media, fp) == "avance"


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", s.lower())


RID = re.compile(r'tvg-id="([^"]*)"')


def parse_pairs(text):
    """[(tvg-id, nom, url, index_de_la_ligne_url)] pour chaque chaîne.

    On saute les commentaires (#EXTVLCOPT, #EXTGRP, « # ALT … ») mais on
    S'ARRÊTE au #EXTINF suivant : sans cette borne, une chaîne dont l'URL est
    commentée (ce que fait check_links.sh avec « # HS [404] … ») « emprunte »
    l'URL de la chaîne suivante. Les deux chaînes pointent alors sur la MÊME
    ligne, et le bot écrit le flux de l'une sur la ligne de l'autre — on se
    retrouve à regarder une autre chaîne que celle affichée.
    """
    out, lines = [], text.split("\n")
    for i, line in enumerate(lines):
        if not line.startswith("#EXTINF"):
            continue
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith(("http://", "https://")):
            if lines[j].startswith("#EXTINF"):
                j = len(lines)          # chaîne sans URL active : on l'ignore
                break
            j += 1
        if j < len(lines):
            m = RID.search(line)
            tid = m.group(1).strip() if m else ""
            name = line.split(",", 1)[-1].strip() if "," in line else ""
            out.append((tid, name, lines[j].strip(), j))
    return out, lines


def core(name):
    """Nom réduit à son cœur identitaire.

    Les agrégateurs collent la provenance et la qualité au nom :
    « 16. CNEWS [1080p-canalplus] », « L'Equipe (1080p) », « W9 [FR][CH-ONLY] ».
    On retire d'abord tout ce qui est entre crochets/parenthèses (provenance),
    puis le numéro de canal en tête et la mention de qualité.
    « 18. L'Equipe (1080p) » -> « lequipe ».
    """
    s = re.sub(r"[\[(\{][^\])\}]*[\])\}]", " ", name or "")   # (...) [...] {...}
    n = norm(s)
    n = re.sub(r"^\d+", "", n)                       # « 18. » en tête
    n = re.sub(r"(2160p|1080p|720p|576p|480p|360p)", "", n)
    n = re.sub(r"(uhd|fhd|hd|sd)$", "", n)
    return n


# Mots « décoratifs » : leur présence en plus dans un libellé ne change pas la
# chaîne désignée (« La Chaîne L'Équipe » == « L'Equipe »).
NOISE = ("chaine", "france", "channel", "direct", "live", "clair", "the",
         "les", "la", "le", "tv", "fr", "en")


def same_channel(a, b):
    """Deux libellés désignent-ils la même chaîne ?

    Garde-fou contre les agrégateurs mal étiquetés : on a déjà vu une entrée
    tvg-id="Cherie25.fr" dont le flux était en réalité RMC Life. Remplacer une
    chaîne par une AUTRE chaîne est pire qu'un lien mort, donc on refuse au
    moindre doute (un refus = on garde l'ancien lien, l'utilisateur voit la
    panne ; une acceptation à tort = il regarde la mauvaise chaîne sans le
    savoir).

    Règle : les cœurs de noms doivent être identiques, à des mots décoratifs
    près. « lequipe » vs « lachainelequipe » -> OK (reste « lachaine »).
    « nickelodeon » vs « nickelodeonjunior » -> refus (reste « junior »).
    """
    x, y = core(a), core(b)
    if not x or not y:
        return True          # pas d'info exploitable : on ne bloque pas
    if x == y:
        return True
    short, long_ = (x, y) if len(x) <= len(y) else (y, x)
    if short not in long_:
        return False
    # ce qui reste en trop doit n'être QUE des mots décoratifs
    rest = long_.replace(short, "", 1)
    changed = True
    while changed and rest:
        changed = False
        for w in NOISE:
            if w in rest:
                rest = rest.replace(w, "", 1)
                changed = True
    return rest == ""


def build_index():
    """{tvgid: [(url, nom)]} et {normname: [(url, nom)]} depuis les sources."""
    by_id, by_name = {}, {}
    for src in SOURCES:
        try:
            txt = get_text(src)
        except Exception as e:
            print(f"  !! source injoignable {src} ({e})")
            continue
        pairs, _ = parse_pairs(txt)
        for tid, name, url, _idx in pairs:
            if not url.startswith("http"):
                continue
            # iptv-org suffixe ses tvg-id (« TSN1.ca@SD », « History.us@East ») :
            # sans ce strip, aucun id de TV.m3u ne matche jamais ces sources.
            tid = tid.split("@", 1)[0].strip()
            if tid:
                by_id.setdefault(tid, [])
                if url not in [u for u, _ in by_id[tid]]:
                    by_id[tid].append((url, name))
            n = norm(name)
            if n:
                by_name.setdefault(n, [])
                if url not in [u for u, _ in by_name[n]]:
                    by_name[n].append((url, name))
        print(f"  + source: {src.split('/')[-1]} ({len(pairs)} chaînes)")
    return by_id, by_name


# Stubs dont l'ADRESSE change (ParaTV déplace ses dossiers TF1 toutes les ~3 h
# et supprime l'ancien) : valables uniquement derrière le proxy en mode id=,
# qui relit la playlist. En lien direct — ou en secours fb= — ils meurent en
# quelques heures. Le dry-run du 2026-09-02 a failli remplacer le secours de
# LCI par l'un d'eux, c'est-à-dire par la source même que le secours protège.
STUBS_ROTATIFS = ("raw.githubusercontent.com/Paradise-91/ParaTV/",)


def est_stub_rotatif(url):
    return any(s in url for s in STUBS_ROTATIFS)


def find_replacement(tid, name, current, by_id, by_name):
    seen, cands = set(), []
    # 1) registre de secours spécifique à la chaîne (vérifié à la main : sûr)
    for u in REGISTRY.get(tid, []):
        if u not in seen:
            seen.add(u); cands.append(u)
    # 2) puis les agrégateurs maintenus (par tvg-id, puis par nom), en écartant
    #    les entrées dont le libellé désigne visiblement une AUTRE chaîne.
    for u, src_name in by_id.get(tid, []) + by_name.get(norm(name), []):
        if u in seen:
            continue
        if not same_channel(name, src_name):
            print(f"      (ignoré: « {src_name[:38]} » ≠ « {name} »)")
            continue
        seen.add(u); cands.append(u)
    for u in cands:
        if u == current:
            continue
        if any(h in u for h in SKIP_HOSTS) or est_stub_rotatif(u):
            continue
        if validate_candidate(u):
            return u
    return None


def ecrire_etat(pairs, results, notes=None):
    """Publie ETAT.md : l'état de chaque chaîne, lisible depuis un téléphone.

    L'utilisateur consulte le dépôt depuis son iPhone : il n'a aucun moyen de
    lancer un script. Ce fichier, committé à chaque passage du bot, est donc
    son tableau de bord. `notes` : précision par ligne (« via proxy », état
    du secours…) ajoutée au détail.
    """
    notes = notes or {}
    par_ligne = {j: (st, raison) for j, (st, raison, _m, _f) in results.items()}
    icone = {"ok": "✅", "geo": "🌍", "dead": "💀"}
    groupes = {}
    for tid, name, url, j in pairs:
        st, raison = par_ligne.get(j, ("?", "non testée"))
        if j in notes:
            raison = " · ".join(x for x in (raison, notes[j]) if x)
        groupes.setdefault(st, []).append((name, raison, url))

    horo = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    out = [f"# État des chaînes\n",
           f"_Mis à jour automatiquement par le bot le {horo}._\n",
           "Vu depuis un runner GitHub aux États-Unis. Un `🌍 403` sur le CDN "
           "officiel d'un diffuseur est un géo-blocage normal : la chaîne "
           "fonctionne depuis sa zone. Sur un pool anonyme, c'est suspect — le "
           "bot cherche alors un remplaçant. Les chaînes « via proxy » sont "
           "testées à travers le proxy Paris, comme le fait ton lecteur ; leur "
           "« secours » est l'adresse vers laquelle le proxy bascule tout seul "
           "si le flux officiel lâche.\n"]
    ordre = [("dead", "💀 En panne"), ("geo", "🌍 Géo-bloquées (403)"),
             ("ok", "✅ Fonctionnelles"), ("?", "❔ Non testées")]
    total = sum(len(v) for v in groupes.values())
    out.append(f"**{total} chaînes** — " + " · ".join(
        f"{lab.split()[0]} {len(groupes.get(cle, []))}" for cle, lab in ordre
        if groupes.get(cle)) + "\n")
    for cle, libelle in ordre:
        lst = groupes.get(cle)
        if not lst:
            continue
        out.append(f"\n## {libelle} ({len(lst)})\n")
        out.append("| Chaîne | Détail |")
        out.append("|---|---|")
        for name, raison, _url in sorted(lst):
            out.append(f"| {name} | {raison or '—'} |")
    with open("ETAT.md", "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(f"\nETAT.md écrit ({total} chaînes).")


def main():
    with open("TV.m3u", encoding="utf-8") as f:
        text = f.read()
    pairs, lines = parse_pairs(text)

    direct = [(t, n, u, j) for (t, n, u, j) in pairs
              if not any(h in u for h in SKIP_HOSTS)]
    resolus = [(t, n, u, j) for (t, n, u, j) in pairs
               if any(h in u for h in SKIP_HOSTS)]
    print(f"{len(pairs)} chaînes ; {len(direct)} à URL directe à vérifier ; "
          f"{len(resolus)} via résolveur (sondées, jamais remplacées).\n")

    # Passe 1 : sonde profonde de chaque chaîne (master -> variante -> segment).
    # Les chaînes via proxy sont sondées à travers le proxy, comme le lecteur.
    results = {}
    for tid, name, url, j in direct + resolus:
        results[j] = probe(url)
    # Secours (&fb=) des liens proxy : sondés eux aussi, avec leurs propres
    # verdicts, pour remplacer un secours mort AVANT qu'on en ait besoin.
    secours = {j: fb for (_t, _n, u, j) in resolus for fb in [fb_of(u)] if fb}
    res_fb = {j: probe(fb) for j, fb in secours.items()}

    # Passe 2 (gel) : LIVE_GAP s plus tard, une playlist média qui n'a pas
    # avancé = flux gelé (serveur qui répond mais vidéo morte — le lecteur
    # affiche « Lecture impossible » alors que le test simple disait vivant).
    if any(st == "ok" for st, _r, _m, _f in list(results.values()) + list(res_fb.values())):
        time.sleep(LIVE_GAP)
        for table in (results, res_fb):
            for j, (st, reason, media, fp) in list(table.items()):
                if st == "ok" and playlist_progress(media, fp) == "gele":
                    table[j] = ("dead", "gelé (la playlist média n'avance plus)", None, None)

    dead = []
    stats = {"ok": 0, "geo": 0, "dead": 0}
    for tid, name, url, j in direct + resolus:
        c, reason = results[j][0], results[j][1]
        stats[c] += 1
        tag = {"ok": "✅", "geo": "🌍", "dead": "💀"}[c]
        via = " (via proxy)" if (tid, name, url, j) in resolus else ""
        print(f"  {tag} {name:24s} {c}{via}" + (f" ({reason})" if reason and c != "ok" else ""))
        if c == "dead":
            dead.append((tid, name, url, j))
    for j, fb in secours.items():
        c, reason = res_fb[j][0], res_fb[j][1]
        nom = next(n for (_t, n, _u, jj) in resolus if jj == j)
        tag = {"ok": "✅", "geo": "🌍", "dead": "💀"}[c]
        print(f"  {tag} {nom:24s} secours {fb[:60]}" + (f" ({reason})" if reason and c != "ok" else ""))

    # Deuxième chance : ces flux « pirates » ont des micro-coupures. Sans ce
    # re-test, un hoquet de quelques secondes suffit à remplacer définitivement
    # une bonne URL (on l'a vu : RTL9 déclarée morte puis vivante 2 min après).
    # Le re-test applique les mêmes exigences que la passe 1 : un flux qui
    # re-répond mais reste gelé demeure condamné.
    fb_morts = [j for j, (st, _r, _m, _f) in res_fb.items() if st == "dead"]
    if dead or fb_morts:
        print(f"\nRe-test dans 60 s des {len(dead) + len(fb_morts)} flux déclarés morts…")
        time.sleep(60)
        confirmees = []
        for tid, name, url, j in dead:
            st, _reason, media, fp = probe(url)
            vivante = st == "geo"
            if st == "ok":
                time.sleep(LIVE_GAP)
                vivante = playlist_progress(media, fp) != "gele"
            if vivante:
                stats["dead"] -= 1
                stats["ok"] += 1
                results[j] = (st, "", None, None)
                print(f"  ↩️  {name:24s} en fait vivante (hoquet passager)")
            else:
                confirmees.append((tid, name, url, j))
        dead = confirmees
        for j in list(fb_morts):
            st, _reason, media, fp = probe(secours[j])
            vivante = st == "geo"
            if st == "ok":
                time.sleep(LIVE_GAP)
                vivante = playlist_progress(media, fp) != "gele"
            if vivante:
                res_fb[j] = (st, "", None, None)
                fb_morts.remove(j)

    # Les chaînes via proxy ne se remplacent pas : c'est le proxy qui bascule
    # seul sur le secours. Le bot signale seulement.
    dead = [(t, n, u, j) for (t, n, u, j) in dead if (t, n, u, j) in direct]

    # Notes pour ETAT.md : provenance et état du secours.
    ic = {"ok": "✅", "geo": "🌍", "dead": "💀"}
    notes = {}
    for tid, name, url, j in resolus:
        note = "via proxy Paris" if PROXY_HOST in url else "via redirecteur"
        if j in secours:
            note += f" · secours {ic[res_fb[j][0]]}"
            if res_fb[j][0] != "ok" and res_fb[j][1]:
                note += f" ({res_fb[j][1]})"
        notes[j] = note

    # 403 sur un pool anonyme : on tente une mise à niveau (voir hote_officiel).
    suspects = [(t, n, u, j) for (t, n, u, j) in direct
                if results[j][0] == "geo" and not hote_officiel(u)]
    if suspects:
        print(f"\n{len(suspects)} chaîne(s) en 403 sur un pool anonyme — "
              "on cherche mieux (remplacement seulement si le candidat JOUE) :")
        for _t, n, _u, _j in suspects:
            print(f"    · {n}")

    print(f"\nRésumé : {stats['ok']} ok · {stats['geo']} géo · {stats['dead']} morts"
          + (f" · secours morts : {len(fb_morts)}" if fb_morts else ""))
    if not dead and not suspects and not fb_morts:
        print("Rien à réparer. 🎉")
        ecrire_etat(pairs, results, notes)
        return 0

    print(f"\nRecherche de remplaçants pour {len(dead)} morte(s), "
          f"{len(suspects)} suspecte(s) et {len(fb_morts)} secours mort(s)…")
    by_id, by_name = build_index()

    healed, unresolved = [], []
    for tid, name, url, j in dead:
        rep = find_replacement(tid, name, url, by_id, by_name)
        if rep:
            lines[j] = rep
            healed.append((name, url, rep))
            print(f"  🔧 {name}: {url}  ->  {rep}")
        else:
            unresolved.append(name)
            print(f"  ⚠️  {name}: aucun remplaçant valide trouvé")

    # Secours mort d'un lien proxy : on le remplace par le suivant qui JOUE
    # (registre puis agrégateurs), sans toucher au reste du lien.
    for j in fb_morts:
        tid, name, url = next((t, n, u) for (t, n, u, jj) in resolus if jj == j)
        rep = find_replacement(tid, name, secours[j], by_id, by_name)
        if rep:
            lines[j] = avec_fb(url, rep)
            healed.append((name, secours[j], rep))
            notes[j] = notes[j].split(" · secours")[0] + " · secours ✅ (remplacé à l'instant)"
            print(f"  🛟 {name} secours: {secours[j]}  ->  {rep}")
        else:
            print(f"  ⚠️  {name}: secours mort et aucun autre secours valide")

    # Les suspectes ne sont remplacées que si l'on trouve un flux qui joue
    # réellement : un flux vérifié vaut mieux qu'un 403 invérifiable, mais un
    # 403 vaut mieux que rien, donc en l'absence de candidat on ne touche pas.
    for tid, name, url, j in suspects:
        rep = find_replacement(tid, name, url, by_id, by_name)
        if rep:
            lines[j] = rep
            healed.append((name, url, rep))
            print(f"  ⬆️  {name} (403 -> flux vérifié): {url}  ->  {rep}")

    print(f"\nRéparées : {len(healed)} · Sans solution : {len(unresolved)}")
    if unresolved:
        print("  non résolues:", ", ".join(unresolved))

    # Le tableau de bord reflète l'état APRÈS réparation.
    for name, avant, _apres in healed:
        for _t, n, u, j in direct:
            if n == name and u == avant and j in results:
                results[j] = ("ok", "réparée à l'instant", None, None)
    ecrire_etat(pairs, results, notes)

    if healed and not DRY:
        # Verrou de sûreté : deux chaînes ne doivent JAMAIS viser la même ligne
        # (sinon on écrit le flux de l'une sur l'autre). On préfère ne rien
        # écrire plutôt que de corrompre la playlist.
        idx = [j for (_t, _n, _u, j) in pairs]
        if len(set(idx)) != len(idx):
            print("\n!! ABANDON : deux chaînes pointent sur la même ligne — "
                  "TV.m3u laissé intact (playlist probablement mal formée).")
            return 1
        with open("TV.m3u", "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("\nTV.m3u mis à jour.")
    elif DRY:
        print("\n(dry-run : TV.m3u non modifié)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
