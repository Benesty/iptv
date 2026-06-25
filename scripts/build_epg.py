#!/usr/bin/env python3
"""
Construit un EPG unique en fusionnant les guides FR + CA + US (epgshare01),
filtré sur les tvg-id réellement présents dans TV.m3u (pour rester léger).
Sortie : epg.xml  (le workflow le gzip + publie sur la branche `epg`).
"""
import io, gzip, re, time, urllib.request
import xml.etree.ElementTree as ET

SOURCES = [
    "https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_CA1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz",
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def fetch(url, tries=4):
    """Télécharge + décompresse, avec pacing/retry (epgshare01 renvoie
    parfois 403/404 sur des requêtes rapprochées)."""
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Referer": "https://epgshare01.online/",
            })
            raw = urllib.request.urlopen(req, timeout=180).read()
            return gzip.decompress(raw)
        except Exception as e:
            last = e
            time.sleep(3 * (n + 1))   # 3s, 6s, 9s
    raise last

# 1) tvg-id présents dans la playlist
ids = set()
for line in open("TV.m3u", encoding="utf-8"):
    m = re.search(r'tvg-id="([^"]+)"', line)
    if m and m.group(1).strip():
        ids.add(m.group(1).strip())
print(f"{len(ids)} tvg-id dans TV.m3u")

channels, programmes, seen = [], [], set()
for i, url in enumerate(SOURCES):
    if i:
        time.sleep(4)   # espace les requêtes (anti rate-limit epgshare01)
    try:
        xml = fetch(url)
    except Exception as e:
        print(f"!! {url} : {e}")
        continue
    nb = 0
    for _ev, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag == "channel":
            cid = el.get("id")
            if cid in ids and cid not in seen:
                seen.add(cid)
                channels.append(ET.tostring(el, encoding="unicode"))
            el.clear()
        elif el.tag == "programme":
            if el.get("channel") in ids:
                programmes.append(ET.tostring(el, encoding="unicode"))
                nb += 1
            el.clear()
    print(f"   {url.split('/')[-1]} : +{nb} programmes")

with open("epg.xml", "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    f.write('<tv generator-info-name="benesty-iptv-merged-epg">\n')
    f.write("".join(channels))
    f.write("".join(programmes))
    f.write("</tv>\n")
print(f"OK -> epg.xml : {len(channels)} chaînes, {len(programmes)} programmes")
