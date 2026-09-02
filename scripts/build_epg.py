#!/usr/bin/env python3
"""
Construit un EPG unique en fusionnant les guides FR + CA + US,
filtré sur les chaînes réellement présentes dans TV.m3u (pour rester léger).

Chaque chaîne du m3u est rattachée à son guide :
  1) par tvg-id exact si la source utilise le même id ;
  2) sinon par correspondance du NOM de la chaîne (normalisé).
Les programmes trouvés sont réétiquetés sur le tvg-id du m3u, donc le lecteur
les affiche même si l'id interne de la source diffère.

Sortie : epg.xml  (le workflow le gzip + publie sur la branche `epg`).
"""
import io, gzip, re, time, unicodedata, urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

# Guides nationaux. epgshare01.online, la source d'origine, s'est mise à
# renvoyer 404 sur son index ET sur ses trois guides le 2026-09-02 : l'EPG
# n'était donc plus reconstruit. open-epg la remplace — mesuré le même jour par
# le workflow `epg-sources` : France 325 chaînes, Canada 127, USA 663.
NATIONAUX = [
    "https://www.open-epg.com/files/france1.xml",
    "https://www.open-epg.com/files/canada1.xml",
    "https://www.open-epg.com/files/unitedstates1.xml",
]
# Guides supplémentaires :
#  - xmltvfr : peu de chaînes (la TNT française) mais très détaillé sur elles ;
#  - Samsung TV Plus : les chaînes FAST absentes des guides nationaux
#    (RMC Life, TV5Monde Voyage, Noovo, CBC Comedy, Gusto…), appariées par
#    tvg-id exact puisque le m3u porte déjà l'identifiant Samsung.
EXTRA = ["https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz",
         "https://i.mjh.nz/SamsungTVPlus/fr.xml",
         "https://i.mjh.nz/SamsungTVPlus/ca.xml"]

# Alias explicites : tvg-id du m3u -> id EXACT d'une chaîne dans un guide source,
# pour les chaînes dont ni l'id ni le nom ne matchent automatiquement.
# (vérifiés le 2026-07-20 dans epgshare01 FR/CA + Samsung TV Plus CA)
ALIAS = {
    "CanalPlus.fr": "Canal+.fr",              # CANAL+ en clair -> guide « Canal+ »
    "CBMT.Montreal.News.ca": "CA4600005WZ",   # CBC News Montréal -> Samsung « CBC News Quebec »
    "CanalPlusCinemas.fr": "Canal+.Cinéma(s).fr",  # Canal+ Cinéma -> guide « Canal+ Cinéma(s) »
    "NoovoComedies.ca": "CA1300001DN",        # Noovo Comédies -> Samsung « Noovo Ça c'est drôle »
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, tries=4):
    """GET brut avec User-Agent navigateur + retry.

    Certains fournisseurs refusent les requêtes sans UA navigateur ou trop
    rapprochées ; le Referer est calé sur l'origine de l'URL demandée.
    """
    p = urlparse(url)
    last = None
    for n in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "*/*",
                "Referer": f"{p.scheme}://{p.netloc}/"})
            return urllib.request.urlopen(req, timeout=180).read()
        except Exception as e:
            last = e
            time.sleep(3 * (n + 1))
    raise last


def decompresse(brut):
    """Rend le XML en clair, que la source soit gzippée ou non.

    Les fournisseurs mélangent les deux (open-epg sert du .xml nu, xmltvfr du
    .xml.gz) : on se fie aux octets magiques plutôt qu'à l'extension.
    """
    return gzip.decompress(brut) if brut[:2] == b"\x1f\x8b" else brut


def norm(s):
    """Nom normalisé pour le matching : minuscules, sans accents ni ponctuation."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def base(s):
    """Retire le suffixe pays/locale final (.fr, .ca2, ...) avant normalisation."""
    return norm(re.sub(r"(\.[a-zA-Z]{2}\d*)+$", "", s or ""))


def ccode(s):
    """Code pays d'un identifiant (« Disney.Channel.fr » -> « fr »), sinon "".

    Indispensable : base() efface volontairement le suffixe pays pour apparier
    « CTV.News.Channel.ca » à « CTV.News.Channel.ca2 ». Sans ce garde-fou,
    « DisneyChannel.us » et « Disney.Channel.fr » se réduisent tous deux à
    « disneychannel », et une chaîne américaine hérite du guide FRANÇAIS.
    """
    m = re.search(r"\.([a-zA-Z]{2})\d*(?:@[^.]*)?$", (s or "").strip())
    return m.group(1).lower() if m else ""


def compatible(tid, cid):
    """Le guide `cid` peut-il servir la chaîne `tid` ? (pays non contradictoires)

    Les identifiants FAST (Samsung/Pluto : « CA4600005WZ ») n'ont pas de suffixe
    pays : on les accepte, on ne peut pas trancher. En revanche deux pays
    explicitement différents = refus.
    """
    a, b = ccode(tid), ccode(cid)
    return not (a and b and a != b)


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
SOURCES = NATIONAUX
print("Sources EPG :", ", ".join(s.split("/")[-1] for s in SOURCES))
feeds = []
for i, url in enumerate(SOURCES):
    if i:
        time.sleep(4)
    try:
        feeds.append(decompresse(get(url)))
    except Exception as e:
        print(f"!! {url} : {e}")

n_nationaux = len(feeds)   # combien de guides nationaux ont réellement été chargés

# guides supplémentaires
for url in EXTRA:
    time.sleep(2)
    try:
        feeds.append(decompresse(get(url)))
        print(f"   + extra : {url.split('/')[-2]}/{url.split('/')[-1]}")
    except Exception as e:
        print(f"!! {url} : {e}")

# 3) passe 1 : index des chaînes du guide (par id et par nom normalisé)
# On garde des LISTES de candidats : le bon sera choisi selon le pays, sinon une
# chaîne américaine peut hériter du guide d'une homonyme française.
chan_xml, name2id, baseid = {}, {}, {}
for xml in feeds:
    for _ev, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag == "channel":
            cid = el.get("id")
            chan_xml.setdefault(cid, ET.tostring(el, encoding="unicode"))
            baseid.setdefault(base(cid), []).append(cid)
            for dn in el.findall("display-name"):
                if dn.text:
                    name2id.setdefault(norm(dn.text), []).append(cid)
            el.clear()
        elif el.tag == "programme":
            el.clear()


def pick(cands, tid):
    """Choisit le candidat du BON pays ; refuse plutôt que de se tromper."""
    if not cands:
        return None
    # 1) même pays explicite
    for c in cands:
        if ccode(tid) and ccode(c) == ccode(tid):
            return c
    # 2) candidat sans pays (identifiants FAST) : acceptable
    for c in cands:
        if compatible(tid, c):
            return c
    return None

# 4) rattachement : tvg-id du m3u -> id source dans le guide
src_of = {}
for tid, name in wanted:
    if tid in chan_xml:
        src_of[tid] = tid
    elif tid in ALIAS and ALIAS[tid] in chan_xml:
        src_of[tid] = ALIAS[tid]
        print(f"   alias {tid:24s} -> {ALIAS[tid]}")
    else:
        sid = (pick(baseid.get(base(tid)), tid) or
               pick(name2id.get(norm(tid.split(".")[0])), tid) or
               pick(name2id.get(norm(name)), tid))
        if sid:
            src_of[tid] = sid
            print(f"   nom→ {tid:24s} ~ {sid}")

tids_for_src = {}
for tid, sid in src_of.items():
    tids_for_src.setdefault(sid, []).append(tid)

# Les non-appariées : sans cette liste, un seuil qui échoue n'indique pas QUOI
# corriger. C'est elle qui dit quels ALIAS ajouter quand un fournisseur change.
orphelines = [(tid, nom) for tid, nom in wanted if tid not in src_of]
if orphelines:
    print(f"\n   {len(orphelines)} chaîne(s) sans guide :")
    for tid, nom in sorted(orphelines, key=lambda x: x[1].lower()):
        print(f"     · {nom[:28]:28} (tvg-id: {tid})")
    print()

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

# 5bis) GARDE-FOU — ne JAMAIS publier un guide amputé.
# Le workflow force-push la branche `epg` : si on écrivait un fichier vide ou
# partiel, il écraserait le dernier bon guide, irrécupérable, et toutes les
# chaînes perdraient leur programme jusqu'au prochain run réussi. Les erreurs
# réseau étant avalées plus haut (les fournisseurs renvoient des 403/404 sur
# requêtes rapprochées, et epgshare01 a fini par disparaître le 2026-09-02),
# on vérifie ici que la moisson est plausible avant d'écrire. C'est ce
# garde-fou qui a préservé le guide ce jour-là.
seuils = [
    (n_nationaux == len(SOURCES),
     f"guides nationaux manquants ({n_nationaux}/{len(SOURCES)})"),
    (len(programmes) >= 5000,
     f"trop peu de programmes ({len(programmes)}, seuil 5000)"),
    (len(channels) >= 0.7 * len(ids),
     f"trop peu de chaînes appariées ({len(channels)}/{len(ids)}, seuil 70%)"),
]
echecs = [msg for ok, msg in seuils if not ok]
if echecs:
    print("\n!! EPG NON PUBLIÉ — moisson incomplète :")
    for msg in echecs:
        print("   -", msg)
    print("   La branche `epg` garde le dernier guide valide. Job en échec exprès.")
    raise SystemExit(1)

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
