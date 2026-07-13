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
import re, sys, time, unicodedata, urllib.request, urllib.error

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


def http(url, read=0):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    r = urllib.request.urlopen(req, timeout=TIMEOUT)
    data = r.read(read) if read else b""
    return r.status, data.decode("utf-8", "replace")


def get_text(url, tries=3):
    last = None
    for n in range(tries):
        try:
            return http(url, read=8_000_000)[1]
        except Exception as e:
            last = e
            time.sleep(2 * (n + 1))
    raise last


def classify(url):
    """ok | geo | dead"""
    try:
        st, body = http(url, read=600)
        if st in (200, 206) and "#EXTM3U" in body:
            return "ok"
        if st in (200, 206) and body.strip().startswith("#EXT"):
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
    """Retourne [(extinf_line, url_line_index_in_lines)] -> ici (tvgid, name, url)."""
    out, lines = [], text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("#EXTINF"):
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or lines[j].startswith("#")):
                j += 1
            if j < len(lines):
                m = RID.search(line)
                tid = m.group(1).strip() if m else ""
                name = line.split(",", 1)[-1].strip() if "," in line else ""
                out.append((tid, name, lines[j].strip(), j))
    return out, lines


def build_index():
    """{tvgid: [urls]} et {normname: [urls]} depuis les sources."""
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
                if url not in by_id[tid]:
                    by_id[tid].append(url)
            n = norm(name)
            if n:
                by_name.setdefault(n, [])
                if url not in by_name[n]:
                    by_name[n].append(url)
        print(f"  + source: {src.split('/')[-1]} ({len(pairs)} chaînes)")
    return by_id, by_name


def find_replacement(tid, name, current, by_id, by_name):
    seen, cands = set(), []
    for u in by_id.get(tid, []):
        if u not in seen:
            seen.add(u); cands.append(u)
    for u in by_name.get(norm(name), []):
        if u not in seen:
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
        with open("TV.m3u", "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("\nTV.m3u mis à jour.")
    elif DRY:
        print("\n(dry-run : TV.m3u non modifié)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
