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
import json, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from heal import probe, playlist_progress, LIVE_GAP  # noqa: E402
import time  # noqa: E402

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
            mort.append((nom, url, raison))
            print(f"  💀 {nom[:52]:52} {raison}")

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
