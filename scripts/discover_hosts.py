#!/usr/bin/env python3
"""Découverte de serveurs hébergeant des chaînes francophones France/Canada.

Usage :
  mkdir agg && cd agg   # y télécharger les playlists agrégatrices (.m3u)
  cd .. && python3 scripts/discover_hosts.py
Sort un tableau par hôte + discovered.json (à passer au workflow test-candidates).

Regroupe les entrées des agrégateurs PAR HÔTE, classe chaque chaîne par pays
(via le suffixe du tvg-id, avec repli sur le nom), et met en avant les hôtes
« pool » (une IP qui sert plusieurs chaînes FR/CA) encore inconnus de TV.m3u.
Exclut les hôtes dominés par l'Afrique francophone.
"""
import re, os, ipaddress
from urllib.parse import urlparse

AGG = os.environ.get("AGG_DIR", "agg")   # dossier des playlists téléchargées
REPO = os.environ.get("REPO_DIR", ".")

FILES = ["fra_lang.m3u", "iptvorg_fr.m3u", "iptvorg_ca.m3u", "paratv.m3u",
         "schumijo.m3u", "freetv_fr.m3u", "freetv_ca.m3u"]

TARGET = {"fr", "ca"}                          # ce qu'on veut
EURO_OTHER = {"be", "ch", "mc", "lu"}          # francophone Europe, hors cible
AFRICA = {"ma", "dz", "tn", "ml", "sn", "ci", "cm", "cd", "cg", "ga", "bj",
          "tg", "ne", "bf", "mr", "gn", "rw", "bi", "td", "km", "dj", "mg", "gq"}

# Mots qui trahissent une chaîne africaine même sans tvg-id pays.
AFRICA_KW = ("afrique", "africa", "afrik", "nessma", "ortm", "canal algerie",
             "algerie", "maroc", "2m ", "tunisie", "senegal", "ivoir", "mali",
             "gabon", "congo", "camerou", "burkina", "novelas", "trace ", "a+ ",
             "aplus", "rti ", "rtb ", "rtnc", "tele congo", "vox africa",
             "mauritan", "guinee", "tchad", "niger", "benin", "togo")

# Hôtes qui ne sont pas des « serveurs de chaînes » mais des redirecteurs /
# stubs / dépôts : on ne les compte pas comme des pools découvrables.
SKIP_HOSTS = ("jmp2.uk", "githubusercontent.com", "github.com",
                    "dailymotion", "youtube", "youtu.be")

def hosts_in_tv():
    """Hôtes déjà présents dans TV.m3u (actifs, commentés, ALT) + pools morts connus."""
    txt = open(os.path.join(REPO, "TV.m3u"), encoding="utf-8").read()
    hs = set()
    for m in re.finditer(r"https?://([^/\s]+)", txt):
        hs.add(m.group(1).lower())
    return hs

def country_of(tid, name):
    base = (tid or "").split("@", 1)[0]
    parts = base.split(".")
    cc = re.sub(r"\d+$", "", parts[-1]).lower() if parts else ""
    low = (name or "").lower()
    if any(k in low for k in AFRICA_KW):
        return "africa"
    if len(cc) == 2:
        if cc in TARGET: return cc
        if cc in AFRICA: return "africa"
        if cc in EURO_OTHER: return "euro"
        return "other"
    return "unknown"

RID = re.compile(r'tvg-id="([^"]*)"')

def parse(text):
    out, lines = [], text.split("\n")
    for i, line in enumerate(lines):
        if not line.startswith("#EXTINF"):
            continue
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith(("http://", "https://")):
            if lines[j].startswith("#EXTINF"):
                j = len(lines); break
            j += 1
        if j < len(lines):
            m = RID.search(line)
            tid = m.group(1).strip() if m else ""
            name = line.split(",", 1)[-1].strip() if "," in line else ""
            out.append((tid, name, lines[j].strip()))
    return out

def is_ip(host):
    h = host.split(":")[0]
    try:
        ipaddress.ip_address(h); return True
    except ValueError:
        return False

known = hosts_in_tv()
# hôtes: {host: {country: count, 'samples': {country:[names]}, 'urls': {country:url}}}
from collections import defaultdict
hosts = defaultdict(lambda: {"fr":0,"ca":0,"africa":0,"euro":0,"other":0,"unknown":0,
                             "samples": defaultdict(list), "url": {}})
for fn in FILES:
    p = os.path.join(AGG, fn)
    if not os.path.exists(p): continue
    for tid, name, url in parse(open(p, encoding="utf-8").read()):
        if not url.startswith("http"): continue
        host = urlparse(url).netloc.lower()
        if not host or any(s in host for s in SKIP_HOSTS): continue
        c = country_of(tid, name)
        H = hosts[host]
        H[c] += 1
        if len(H["samples"][c]) < 6 and name:
            H["samples"][c].append(name[:34])
        H["url"].setdefault(c, url)

# On veut les hôtes qui servent >=1 FR ou CA, PAS dominés par l'Afrique,
# et pas déjà dans TV.m3u.
rows = []
for host, H in hosts.items():
    frca = H["fr"] + H["ca"]
    if frca == 0:
        continue
    if H["africa"] > frca:            # dominé par l'Afrique -> écarté
        continue
    already = host in known
    rows.append((frca, H["fr"], H["ca"], H["africa"], is_ip(host), already, host, H))

rows.sort(key=lambda r: (-r[0], r[6]))

print(f"{'HÔTE':42} FR  CA  AF  IP  connu   exemples")
print("=" * 110)
new_pools = []
for frca, fr, ca, af, ip, already, host, H in rows:
    flag = "déjà" if already else "NEW"
    samp = []
    for c in ("fr","ca"):
        samp += H["samples"][c]
    print(f"{host:42} {fr:3} {ca:3} {af:3}  {'Y' if ip else '.'}  {flag:5}  {', '.join(samp[:5])[:52]}")
    if not already and (fr+ca) >= 2:
        new_pools.append((host, fr, ca, af, ip, H))

print(f"\n\n########## {len(new_pools)} HÔTES NOUVEAUX servant >=2 chaînes FR/CA ##########\n")
import json
out_cands = []
for host, fr, ca, af, ip, H in new_pools:
    kind = "IP-pool" if ip else "CDN/domaine"
    print(f"— {host}  [{kind}]  FR={fr} CA={ca}" + (f" (Afrique={af})" if af else ""))
    for c in ("fr","ca"):
        if H["samples"][c]:
            print(f"     {c.upper()}: {', '.join(H['samples'][c])}")
    # 1 URL représentative par hôte pour le banc d'essai
    u = H["url"].get("fr") or H["url"].get("ca")
    if u:
        out_cands.append({"name": f"DÉCOUVERTE {host} [{kind}] FR={fr} CA={ca}",
                          "url": u, "langue": "fr", "pour": host})
json.dump(out_cands, open("discovered.json","w"), indent=1, ensure_ascii=False)
print(f"\n{len(out_cands)} hôtes -> discovered.json (1 URL test par hôte)")
