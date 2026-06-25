#!/usr/bin/env python3
"""
Construit un EPG unique en fusionnant les guides FR + CA + US (epgshare01),
filtré sur les chaînes réellement présentes dans TV.m3u (pour rester léger).

Chaque chaîne du m3u est rattachée à son guide :
  1) par tvg-id exact si epgshare01 utilise le même id ;
  2) sinon par correspondance du NOM de la chaîne (normalisé).
Les programmes trouvés sont réétiquetés sur le tvg-id du m3u, donc le lecteur
les affiche même si l'id interne d'epgshare01 diffère.

Sortie : epg.xml  (le workflow le gzip + publie sur la branche `epg`).
"""
import io, gzip, re, time, unicodedata, urllib.request
import xml.etree.ElementTree as ET

BASE = "https://epgshare01.online/epgshare01/"
WANT = ("FR", "CA", "US")                       # flux nationaux voulus
FALLBACK = [BASE + f"epg_ripper_{c}1.xml.gz" for c in WANT]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, tries=4):
    """GET brut avec User-Agent navigateur + retry (epgshare01 renvoie
    403/404 sans UA navigateur ou sur requêtes rapprochées)."""
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "*/*", "Referer": BASE})
            return urllib.request.urlopen(req, timeout=180).read()
        except Exception as e:
            last = e
            time.sleep(3 * (n + 1))
    raise last


def discover():
    """Choisit, pour chaque pays, le 1er flux national epg_ripper_XX<n>.xml.gz
    (sans _LOCALS). Robuste aux renommages côté epgshare01 (CA1->CA2, etc.)."""
    try:
        html = get(BASE).decode("utf-8", "replace")
    except Exception as e:
        print(f"!! index epgshare01 injoignable ({e}) -> fallback")
        return FALLBACK
    files = set(re.findall(r"epg_ripper_[A-Z0-9_]+\.xml\.gz", html))
    chosen = []
    for c in WANT:
        cands = sorted(f for f in files
                       if re.fullmatch(rf"epg_ripper_{c}\d+\.xml\.gz", f))
        if cands:
            chosen.append(BASE + cands[0])
        else:
            print(f"!! aucun flux national '{c}' dans l'index")
    return chosen or FALLBACK


def norm(s):
    """Nom normalisé pour le matching : minuscules, sans accents ni ponctuation."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def base(s):
    """Retire le suffixe pays/locale final (.fr, .ca2, ...) avant normalisation."""
    return norm(re.sub(r"(\.[a-zA-Z]{2}\d*)+$", "", s or ""))


# 1) chaînes du m3u : (tvg-id, nom affiché)
wanted = []
rid = re.compile(r'tvg-id="([^"]*)"')
for line in open("TV.m3u", encoding="utf-8"):
    if line.startswith("#EXTINF"):
        m = rid.search(line)
        tid = m.group(1).strip() if m else ""
        name = line.rstrip("\n").split(",", 1)[-1].strip() if "," in line else ""
        if tid:
            wanted.append((tid, name))
ids = {t for t, _ in wanted}
print(f"{len(wanted)} chaînes avec tvg-id dans TV.m3u")

# 2) télécharge les flux (gardés en mémoire pour 2 passes)
SOURCES = discover()
print("Sources EPG :", ", ".join(s.split("/")[-1] for s in SOURCES))
feeds = []
for i, url in enumerate(SOURCES):
    if i:
        time.sleep(4)
    try:
        feeds.append(gzip.decompress(get(url)))
    except Exception as e:
        print(f"!! {url} : {e}")

# 3) passe 1 : index des chaînes du guide (par id et par nom normalisé)
chan_xml, name2id, baseid = {}, {}, {}
for xml in feeds:
    for _ev, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag == "channel":
            cid = el.get("id")
            chan_xml.setdefault(cid, ET.tostring(el, encoding="unicode"))
            baseid.setdefault(base(cid), cid)
            for dn in el.findall("display-name"):
                if dn.text:
                    name2id.setdefault(norm(dn.text), cid)
            el.clear()
        elif el.tag == "programme":
            el.clear()

# 4) rattachement : tvg-id du m3u -> id source dans le guide
src_of = {}
for tid, name in wanted:
    if tid in chan_xml:
        src_of[tid] = tid
    else:
        sid = (baseid.get(base(tid)) or
               name2id.get(norm(tid.split(".")[0])) or
               name2id.get(norm(name)))
        if sid:
            src_of[tid] = sid
            print(f"   nom→ {tid:24s} ~ {sid}")

tids_for_src = {}
for tid, sid in src_of.items():
    tids_for_src.setdefault(sid, []).append(tid)

# 5) passe 2 : <channel> (réétiquetés sur le tvg-id m3u) + programmes
channels = []
for tid, sid in src_of.items():
    cx = chan_xml[sid].replace(f'id="{sid}"', f'id="{tid}"', 1)
    channels.append(cx)

programmes = []
for xml in feeds:
    for _ev, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag == "programme":
            ch = el.get("channel")
            if ch in tids_for_src:
                for tid in tids_for_src[ch]:
                    el.set("channel", tid)
                    programmes.append(ET.tostring(el, encoding="unicode"))
            el.clear()
        elif el.tag == "channel":
            el.clear()

with open("epg.xml", "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    f.write('<tv generator-info-name="benesty-iptv-merged-epg">\n')
    f.write("".join(channels))
    f.write("".join(programmes))
    f.write("</tv>\n")
print(f"OK -> epg.xml : {len(channels)} chaînes, {len(programmes)} programmes")

missing = sorted(ids - set(src_of))
if missing:
    print(f"\n!! {len(missing)} tvg-id SANS EPG :")
    for cid in missing:
        print(f"   - {cid}")
