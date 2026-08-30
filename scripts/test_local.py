#!/usr/bin/env python3
"""Teste les flux DEPUIS TA MACHINE (Québec) — playlist entière ou candidats.

Pourquoi ce script existe
-------------------------
Un runner GitHub ne voit pas la même chose que toi : beaucoup de serveurs
répondent 403 à un datacenter. Le dépôt supposait qu'un 403 = « géo-bloqué,
donc bon chez toi » — mais quand une chaîne comme 6ter est 403 pour le runner
ET morte chez toi, cette hypothèse est fausse. Seul un test depuis ta connexion
tranche.

Il vérifie trois choses que les tests précédents rataient :
  1. le flux répond et sert un vrai segment vidéo (test profond) ;
  2. la playlist AVANCE (sinon l'image est figée) ;
  3. il y a bien une PISTE VIDÉO — c'est le cas « du son mais pas d'image ».

Usage
-----
    python3 scripts/test_local.py                 # TOUTE la playlist TV.m3u
    python3 scripts/test_local.py candidates.json # un lot de candidats
    python3 scripts/test_local.py --rapide        # sans la preuve d'avance

Sortie : ✅ OK · 🔇 SON SEUL (pas d'image) · ❄️ GELÉ · 🌍 GÉO · 💀 MORT
"""
import json, sys, os, socket, ssl, subprocess, shutil, re, time
import concurrent.futures as cf
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import heal  # noqa: E402
from heal import probe, playlist_progress, parse_pairs, http_full, LIVE_GAP  # noqa: E402

# 71 chaînes en série, avec des serveurs qui laissent expirer les connexions,
# c'est dix minutes d'attente. On raccourcit le délai et on teste en parallèle.
heal.TIMEOUT = 8
PARALLELE = 8

RAPIDE = "--rapide" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
CIBLE = args[0] if args else "TV.m3u"

VIDEO_CODECS = ("avc1", "avc3", "hvc1", "hev1", "av01", "vp09", "mp4v")
FFPROBE = shutil.which("ffprobe")


# ---------------------------------------------------------------- diagnostic
def diagnostic(url):
    """Pourquoi ça a échoué, en clair (DNS / TCP / TLS / HTTP)."""
    u = urlparse(url)
    host, port = u.hostname or "", u.port or (443 if u.scheme == "https" else 80)
    try:
        ip = socket.getaddrinfo(host, None)[0][4][0]
    except Exception:
        return "DNS-KO : ce nom d'hôte n'existe plus"
    try:
        socket.create_connection((host, port), timeout=8).close()
    except Exception as e:
        return f"TCP-KO vers {ip}:{port} ({type(e).__name__})"
    for insecure in (False, True):
        cmd = ["curl", "-sS", "-o", "/dev/null", "-m", "12", "-L",
               "-A", "VLC/3.0.20 LibVLC/3.0.20", "-w", "%{http_code}"]
        if insecure:
            cmd.append("-k")
        cmd.append(url)
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        except Exception as e:
            return f"requête KO ({type(e).__name__})"
        code = (p.stdout or "").strip()
        if code and code != "000":
            return f"HTTP {code}" + (" [certificat non vérifié]" if insecure else "")
        err = (p.stderr or "").strip()[:60]
    return f"injoignable : {err}"


# ------------------------------------------------------------- piste vidéo ?
def a_de_la_video(url):
    """(bool|None, détail) — y a-t-il une piste VIDÉO ?

    None = indéterminé (on ne condamne pas sans preuve).

    ffprobe donne la réponse certaine quand il est installé. Sinon on lit les
    attributs du manifeste : un flux dont AUCUNE variante n'annonce ni
    RESOLUTION ni codec vidéo est du son seul — c'est le symptôme « j'entends
    mais je ne vois rien ».
    """
    if FFPROBE:
        try:
            p = subprocess.run(
                [FFPROBE, "-v", "error", "-select_streams", "v",
                 "-show_entries", "stream=codec_name,width,height",
                 "-of", "csv=p=0", "-timeout", "10000000", url],
                capture_output=True, text=True, timeout=35)
            sortie = (p.stdout or "").strip()
            if sortie:
                return True, f"vidéo {sortie.splitlines()[0]}"
            if p.returncode == 0:
                return False, "ffprobe ne voit AUCUNE piste vidéo"
        except Exception:
            pass                                   # on retombe sur le manifeste
    try:
        _st, texte, _ct, _final = http_full(url)
    except Exception:
        return None, ""
    if "#EXT-X-STREAM-INF" not in texte:
        return None, ""                            # playlist média : indécidable ici
    infos = re.findall(r"#EXT-X-STREAM-INF:([^\n]*)", texte)
    if not infos:
        return None, ""
    for attrs in infos:
        if "RESOLUTION=" in attrs:
            return True, ""
        codecs = re.search(r'CODECS="([^"]*)"', attrs)
        if codecs and any(c in codecs.group(1).lower() for c in VIDEO_CODECS):
            return True, ""
    return False, "aucune variante n'annonce de vidéo (son seul)"


# ------------------------------------------------------------------- entrées
def charge():
    """[(nom, url)] depuis TV.m3u ou un JSON de candidats."""
    if CIBLE.endswith((".m3u", ".m3u8")):
        texte = open(CIBLE, encoding="utf-8").read()
        paires, _ = parse_pairs(texte)
        return [(nom or tid or url, url) for tid, nom, url, _j in paires]
    data = json.load(open(CIBLE, encoding="utf-8"))
    return [(c.get("name") or c.get("pour") or c["url"], c["url"]) for c in data]


def main():
    try:
        entrees = charge()
    except FileNotFoundError:
        print(f"Fichier introuvable : {CIBLE}")
        return 1
    if not entrees:
        print(f"{CIBLE} ne contient aucune entrée.")
        return 0

    print(f"{len(entrees)} flux — test depuis TON réseau"
          f"{'  (rapide)' if RAPIDE else f'  (preuve d''avance {LIVE_GAP} s)'}"
          f"{'  · ffprobe présent' if FFPROBE else '  · sans ffprobe (heuristique manifeste)'}\n")

    # --- passe 1 : sonde profonde (en parallèle)
    # Le repli « certificat non vérifié » modifie un réglage global de ssl :
    # on ne peut donc pas le faire dans les fils. On repère d'abord les cas,
    # puis on les rejoue en série, une fois le parallèle terminé.
    def sonde(entree):
        nom, url = entree
        return url, list(probe(url)) + [nom]

    etat = {}
    fait = 0
    with cf.ThreadPoolExecutor(max_workers=PARALLELE) as ex:
        for url, res in ex.map(sonde, entrees):
            etat[url] = res
            fait += 1
            print(f"\r  sondé {fait}/{len(entrees)}", end="", flush=True)
    print()

    a_rejouer = [u for u, v in etat.items()
                 if v[0] == "dead" and u.startswith("https://")
                 and v[1] in ("URLError", "SSLError", "SSLCertVerificationError", "OSError")]
    if a_rejouer:
        ancien = ssl._create_default_https_context
        try:                                       # certificat non conforme : comme VLC
            ssl._create_default_https_context = ssl._create_unverified_context
            for url in a_rejouer:
                st2, raison2, media2, fp2 = probe(url)
                if st2 != "dead":
                    nom = etat[url][4]
                    etat[url] = [st2, (raison2 + " " if raison2 else "") + "[cert. non vérifié]",
                                 media2, fp2, nom]
        finally:
            ssl._create_default_https_context = ancien

    # --- passe 2 : la playlist avance-t-elle ? (un seul temps d'attente global)
    if not RAPIDE and any(v[0] == "ok" for v in etat.values()):
        time.sleep(LIVE_GAP)
        for url, v in etat.items():
            if v[0] == "ok" and playlist_progress(v[2], v[3]) == "gele":
                v[0], v[1] = "gele", "l'image est figée (playlist qui n'avance plus)"

    # --- passe 3 : y a-t-il une image ? (en parallèle aussi)
    vivants = [u for u, v in etat.items() if v[0] == "ok"]
    if vivants:
        with cf.ThreadPoolExecutor(max_workers=PARALLELE) as ex:
            for url, (ok_video, detail) in zip(vivants, ex.map(a_de_la_video, vivants)):
                if ok_video is False:
                    etat[url][0], etat[url][1] = "audio", detail

    # Diagnostic détaillé des morts (DNS/TCP/HTTP), en parallèle : chaque appel
    # peut attendre deux délais curl, ce qui serait interminable en série.
    flous = [u for u, v in etat.items()
             if v[0] == "dead" and v[1] in ("URLError", "timeout", "TimeoutError", "OSError")]
    if flous:
        print(f"  diagnostic de {len(flous)} flux injoignables…", flush=True)
        with cf.ThreadPoolExecutor(max_workers=PARALLELE) as ex:
            for url, detail in zip(flous, ex.map(diagnostic, flous)):
                etat[url][1] = detail

    groupes = {"ok": [], "audio": [], "gele": [], "geo": [], "dead": []}
    for url, (st, raison, _m, _f, nom) in etat.items():
        groupes[st if st in groupes else "dead"].append((nom, url, raison))

    icone = {"ok": "✅", "audio": "🔇", "gele": "❄️", "geo": "🌍", "dead": "💀"}
    titre = {"ok": "OK", "audio": "SON SEUL — pas d'image",
             "gele": "GELÉ — image figée", "geo": "GÉO (403/401)", "dead": "MORT"}
    for cle in ("dead", "audio", "gele", "geo", "ok"):
        lst = groupes[cle]
        if not lst:
            continue
        print(f"\n{icone[cle]} {titre[cle]} : {len(lst)}")
        for nom, _url, raison in sorted(lst):
            print(f"   {nom[:40]:40} {raison[:60]}")

    print(f"\n{'=' * 66}")
    print("  ".join(f"{icone[c]} {len(groupes[c])}" for c in
                    ("ok", "audio", "gele", "geo", "dead")))
    print("\nRenvoie-moi cette sortie : je répare ce qui est cassé.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
