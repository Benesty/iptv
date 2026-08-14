#!/usr/bin/env python3
"""Teste candidates.json DEPUIS TA MACHINE (Québec).

Pourquoi ce script existe
-------------------------
Beaucoup de serveurs de restream refusent les IP de datacenter : ils ne
répondent ni au runner GitHub, ni au proxy Vercel, mais très bien à une
connexion résidentielle. Vus d'un runner, ils sont indiscernables d'un flux
mort — le diagnostic `diag-hosts` les classe « TCP-KO », c'est-à-dire
« indécidable d'ici ». Ce script tranche depuis chez toi.

Il applique EXACTEMENT le test du bot d'auto-réparation (scripts/heal.py) :
    master -> variante -> premier segment vidéo, puis preuve que la playlist
    média AVANCE (sinon le flux est gelé et ne jouera pas).

Usage
-----
    python3 scripts/test_local.py                  # teste candidates.json
    python3 scripts/test_local.py autre.json       # teste un autre fichier
    python3 scripts/test_local.py --rapide         # saute la preuve de vie

Sortie : ✅ JOUE (utilisable) · 🌍 GÉO (403/401) · 💀 MORT (+ raison)
Les URLs qui passent peuvent être collées telles quelles dans TV.m3u.
"""
import json, sys, os, socket, ssl, subprocess
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from heal import probe, playlist_progress, LIVE_GAP  # noqa: E402
import time  # noqa: E402


def diagnostic(url):
    """Pourquoi ça a échoué, en clair.

    « URLError » ne dit rien : DNS mort, connexion refusée et certificat SSL
    rejeté par le Python d'Apple donnent le même mot, alors que ça change tout.
    On sépare donc les couches, et on refait un essai avec curl (qui utilise le
    magasin de certificats du système, pas celui de Python) : si curl passe là
    où Python échoue, le flux est bon et c'est Python qu'il faut réparer.
    """
    u = urlparse(url)
    host = u.hostname or ""
    port = u.port or (443 if u.scheme == "https" else 80)

    try:
        ip = socket.getaddrinfo(host, None)[0][4][0]
    except Exception:
        return "DNS-KO : ce nom d'hôte n'existe plus (flux vraiment mort)"

    try:
        socket.create_connection((host, port), timeout=8).close()
    except Exception as e:
        return f"TCP-KO vers {ip}:{port} ({type(e).__name__}) : serveur injoignable ou qui te filtre"

    if u.scheme == "https":
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((host, port), timeout=8) as s:
                ctx.wrap_socket(s, server_hostname=host).close()
        except ssl.SSLCertVerificationError:
            return ("SSL-KO : certificat rejeté par CE Python (souvent le Python d'Apple "
                    "sans magasin de certificats) — le flux peut être bon, voir curl ci-dessous")
        except Exception as e:
            return f"TLS-KO ({type(e).__name__})"

    try:
        p = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-m", "12", "-L",
             "-A", "VLC/3.0.20 LibVLC/3.0.20", "-w", "%{http_code}", url],
            capture_output=True, text=True, timeout=20)
        code = (p.stdout or "").strip()
        if code and code != "000":
            return f"TCP+TLS OK, curl obtient HTTP {code} (Python a échoué : problème côté Python)"
        return f"curl échoue aussi : {(p.stderr or '').strip()[:70]}"
    except Exception as e:
        return f"connexion établie mais requête KO ({type(e).__name__})"

RAPIDE = "--rapide" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
FICHIER = args[0] if args else "candidates.json"


def main():
    try:
        cands = json.load(open(FICHIER, encoding="utf-8"))
    except FileNotFoundError:
        print(f"Fichier introuvable : {FICHIER}")
        return 1
    if not cands:
        print(f"{FICHIER} est vide — rien à tester.")
        return 0

    print(f"{len(cands)} candidat(s) — test profond depuis TON réseau"
          f"{' (mode rapide, sans preuve de vie)' if RAPIDE else f', preuve de vie {LIVE_GAP} s'}\n")

    joue, geo, mort = [], [], []
    for c in cands:
        url = c.get("url", "")
        nom = c.get("name") or c.get("pour") or url
        st, raison, media, fp = probe(url)

        if st == "ok" and not RAPIDE:
            time.sleep(LIVE_GAP)
            avance = playlist_progress(media, fp)
            if avance == "gele":
                st, raison = "dead", "gelé (la playlist média n'avance plus)"
            elif avance == "inconnu":
                raison = "vivant, mais avance non prouvée"

        if st == "ok":
            joue.append((nom, url, raison))
            print(f"  ✅ {nom[:52]:52} JOUE" + (f"  ({raison})" if raison else ""))
        elif st == "geo":
            geo.append((nom, url, raison))
            print(f"  🌍 {nom[:52]:52} GÉO ({raison})")
        else:
            # « URLError » ne suffit pas à décider : on cherche la vraie cause.
            if raison in ("URLError", "timeout", "TimeoutError", "OSError", "SSLError"):
                raison = diagnostic(url)
            mort.append((nom, url, raison))
            print(f"  💀 {nom[:44]:44} {raison}")

    print(f"\n{'=' * 70}")
    print(f"JOUE : {len(joue)}   ·   GÉO : {len(geo)}   ·   MORT : {len(mort)}")

    if joue:
        print("\n### Utilisables tout de suite — colle ces URLs dans TV.m3u :")
        for nom, url, _ in joue:
            print(f"  {nom}\n    {url}")
    if geo:
        print("\n### Géo-bloquées depuis chez toi (403/401) : inutilisables ici.")
        for nom, _u, _r in geo:
            print(f"  {nom}")

    print("\nRenvoie-moi cette sortie et je mets TV.m3u à jour en conséquence.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
