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
  ok   = HTTP 200 + manifeste #EXTM3U            -> on garde
  geo  = HTTP 403/401 (géo-bloqué CA/FR)         -> on garde (marche chez toi)
  dead = 000/404/timeout/HTML/…                  -> on répare
"""
import re, sys, time, unicodedata, urllib.request, urllib.error, urllib.parse

TIMEOUT = 15
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
DRY = "--dry-run" in sys.argv

# Résolveurs / redirecteurs qui se réparent seuls : on n'y touche jamais.
SKIP_HOSTS = ("iptv-lake-three.vercel.app", "jmp2.uk")

# Playlists sources maintenues (agrégateurs FR). On y cherche un remplaçant.
SOURCES = [
    "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_france.m3u8",
    "https://iptv-org.github.io/iptv/countries/fr.m3u",
    "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/playlists/paratv/main/paratv-highest.m3u",
    "https://raw.githubusercontent.com/schumijo/iptv/main/fr.m3u8",
]

# Registre de candidats par tvg-id. Les chaînes commerciales/payantes FR (M6,
# 6ter, kids…) ne figurent PAS dans les agrégateurs ci-dessus : leurs seuls flux
# sont des restreams sur des pools d'IP. On garde ici un pool de secours par
# chaîne (validé le 2026-07-17), essayé EN PREMIER quand la chaîne meurt, dans
# l'ordre de préférence. Ajoute-z-en librement : le bot valide avant d'écrire.
REGISTRY = {
    "M6.fr": [
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


def classify(url):
    """ok | geo | dead

    Test PROFOND : master -> variante -> premier segment vidéo. Un flux dont le
    manifeste répond 200 mais dont les segments sont morts est bien classé
    « dead » (un simple test du manifeste le déclarait vivant à tort, et le bot
    ne réparait donc jamais ce cas — le plus fréquent en pratique).
    """
    try:
        st, body, ct, final = http_full(url)
        if st not in (200, 206) or not body.lstrip().startswith("#EXT"):
            return "dead"

        cur, text = final, body
        # master (plusieurs qualités) -> on descend d'un niveau
        if "#EXT-X-STREAM-INF" in text:
            v = _first_uri(text, cur)
            if not v:
                return "dead"
            st, text, ct, cur = http_full(v)
            if st not in (200, 206) or not text.lstrip().startswith("#EXT"):
                return "dead"

        seg = _first_uri(text, cur)
        if not seg:
            return "dead"
        st, chunk, ct, _ = http_full(seg, rng="bytes=0-2000")
        if st in (200, 206) and len(chunk) > 200 and "html" not in (ct or "").lower():
            return "ok"
        return "dead"
    except urllib.error.HTTPError as e:
        return "geo" if e.code in (401, 403) else "dead"
    except Exception:
        return "dead"


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
        if any(h in u for h in SKIP_HOSTS):
            continue
        if classify(u) == "ok":
            return u
    return None


def main():
    with open("TV.m3u", encoding="utf-8") as f:
        text = f.read()
    pairs, lines = parse_pairs(text)

    direct = [(t, n, u, j) for (t, n, u, j) in pairs
              if not any(h in u for h in SKIP_HOSTS)]
    print(f"{len(pairs)} chaînes ; {len(direct)} à URL directe à vérifier ; "
          f"{len(pairs) - len(direct)} via résolveur (ignorées).\n")

    dead = []
    stats = {"ok": 0, "geo": 0, "dead": 0}
    for tid, name, url, j in direct:
        c = classify(url)
        stats[c] += 1
        tag = {"ok": "✅", "geo": "🌍", "dead": "💀"}[c]
        print(f"  {tag} {name:24s} {c}")
        if c == "dead":
            dead.append((tid, name, url, j))

    # Deuxième chance : ces flux « pirates » ont des micro-coupures. Sans ce
    # re-test, un hoquet de quelques secondes suffit à remplacer définitivement
    # une bonne URL (on l'a vu : RTL9 déclarée morte puis vivante 2 min après).
    if dead:
        print(f"\nRe-test dans 60 s des {len(dead)} chaîne(s) déclarées mortes…")
        time.sleep(60)
        confirmees = []
        for tid, name, url, j in dead:
            if classify(url) == "dead":
                confirmees.append((tid, name, url, j))
            else:
                stats["dead"] -= 1
                stats["ok"] += 1
                print(f"  ↩️  {name:24s} en fait vivante (hoquet passager)")
        dead = confirmees

    print(f"\nRésumé direct : {stats['ok']} ok · {stats['geo']} géo · {stats['dead']} morts")
    if not dead:
        print("Rien à réparer. 🎉")
        return 0

    print(f"\nRecherche de remplaçants pour {len(dead)} chaîne(s) mortes…")
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

    print(f"\nRéparées : {len(healed)} · Sans solution : {len(unresolved)}")
    if unresolved:
        print("  non résolues:", ", ".join(unresolved))

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
