#!/usr/bin/env python3
"""Test local de la nouvelle logique heal.py avec un faux serveur HLS.

Cas couverts :
  1. flux vivant qui avance          -> ok, candidat ACCEPTÉ
  2. flux gelé (manifeste figé)      -> sweep: dead "gelé", candidat REFUSÉ
  3. VOD/clip avec ENDLIST           -> dead direct (cas ParaTV « indisponible »)
  4. master -> variante -> segments  -> descente correcte
  5. DRM                             -> dead
  6. re-lecture en échec             -> "inconnu" (ne condamne pas)
"""
import http.server, threading, time, sys, os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import heal
heal.LIVE_GAP = 2  # accélère le test (25 s en prod)

STATE = {"seq": 100, "advance": True, "fail_refetch": False, "hits": {}}

def media_playlist():
    if STATE["advance"]:
        STATE["seq"] += 1
    s = STATE["seq"]
    return (f"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n"
            f"#EXT-X-MEDIA-SEQUENCE:{s}\n"
            f"#EXTINF:1.0,\nseg{s}.ts\n#EXTINF:1.0,\nseg{s+1}.ts\n")

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ct="application/vnd.apple.mpegurl"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        p = self.path
        STATE["hits"][p] = STATE["hits"].get(p, 0) + 1
        if p == "/master.m3u8":
            self.send(200, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n/media.m3u8\n")
        elif p == "/media.m3u8":
            if STATE["fail_refetch"] and STATE["hits"][p] > 1:
                self.send(500, "boom", ct="text/plain")
            else:
                self.send(200, media_playlist())
        elif p == "/audio_only.m3u8":
            self.send(200, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\n/media.m3u8\n')
        elif p == "/vod.m3u8":
            self.send(200, "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nclip0.ts\n#EXT-X-ENDLIST\n")
        elif p == "/drm.m3u8":
            self.send(200, '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"\n#EXTINF:6.0,\nseg.ts\n')
        elif p.endswith(".ts"):
            self.send(200, b"G" * 1500, ct="video/mp2t")
        else:
            self.send(404, "nope", ct="text/plain")

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{port}"
ok = True

def check(label, got, want):
    global ok
    good = got == want
    ok &= good
    print(f"  {'✅' if good else '❌'} {label}: {got!r} (attendu {want!r})")

print("1. flux vivant (avance) :")
st, r, media, fp = heal.probe(f"{base}/master.m3u8")
check("probe.status", st, "ok")
check("media résolue", media, f"{base}/media.m3u8")
time.sleep(2)
check("progress", heal.playlist_progress(media, fp), "avance")
check("validate_candidate", heal.validate_candidate(f"{base}/master.m3u8"), True)

print("2. flux gelé :")
STATE["advance"] = False
st, r, media, fp = heal.probe(f"{base}/master.m3u8")
check("probe.status (le gel ne se voit pas en 1 lecture)", st, "ok")
time.sleep(2)
check("progress", heal.playlist_progress(media, fp), "gele")
check("validate_candidate refuse", heal.validate_candidate(f"{base}/master.m3u8"), False)
STATE["advance"] = True

print("2bis. flux AUDIO SEUL (cas M6 signale par l'utilisateur) :")
st, r, _m, _f = heal.probe(f"{base}/audio_only.m3u8")
check("probe.status", st, "dead")
check("raison mentionne l'image", "image" in r or "vid" in r, True)

print("3. VOD/clip ENDLIST :")
st, r, _m, _f = heal.probe(f"{base}/vod.m3u8")
check("probe.status", st, "dead")
check("raison mentionne ENDLIST/VOD", "VOD" in r or "ENDLIST" in r, True)

print("4. DRM :")
st, r, _m, _f = heal.probe(f"{base}/drm.m3u8")
check("probe.status", st, "dead")

print("5. re-lecture en échec -> inconnu (on ne condamne pas) :")
STATE["fail_refetch"] = True
STATE["hits"]["/media.m3u8"] = 0
st, r, media, fp = heal.probe(f"{base}/master.m3u8")
check("probe.status", st, "ok")
check("progress sur erreur", heal.playlist_progress(media, fp), "inconnu")
STATE["fail_refetch"] = False

print("6. 404 :")
st, r, _m, _f = heal.probe(f"{base}/absent.m3u8")
check("probe.status", st, "dead")

print("7. secours (&fb=) d'un lien proxy :")
lien = "https://iptv-lake-three.vercel.app/api/fr?id=TF1.fr&fb=http%3A%2F%2F151.80.18.177%3A86%2FTF1_HD%2Findex.m3u8"
check("fb_of lit le secours", heal.fb_of(lien), "http://151.80.18.177:86/TF1_HD/index.m3u8")
check("fb_of sans secours", heal.fb_of("https://iptv-lake-three.vercel.app/api/fr?id=TMC.fr"), None)
check("fb_of hors proxy", heal.fb_of("http://151.80.18.177:86/TMC/index.m3u8"), None)
nouveau = heal.avec_fb(lien, "http://145.239.5.177/368/index.m3u8")
check("avec_fb remplace le secours", heal.fb_of(nouveau), "http://145.239.5.177/368/index.m3u8")
check("avec_fb garde l'id", "id=TF1.fr" in nouveau, True)
u_lien = ("https://iptv-lake-three.vercel.app/api/fr?u=https%3A%2F%2Fraw.githubusercontent.com"
          "%2FParadise-91%2FParaTV%2Fmain%2Fstreams%2Ffrancetv%2Fres%2Ffrance-2-highest.m3u8")
ajout = heal.avec_fb(u_lien, "http://89.187.185.76:8080/France2/index.m3u8")
check("avec_fb ajoute un secours sans altérer u=", ajout.startswith(u_lien + "&fb="), True)
check("avec_fb est idempotent", heal.avec_fb(ajout, "http://89.187.185.76:8080/France2/index.m3u8"), ajout)
pairs, _lines = heal.parse_pairs("#EXTM3U\n#EXTINF:-1 tvg-id=\"TF1.fr\",TF1\n" + lien + "\n")
check("parse_pairs conserve le lien avec fb=", pairs[0][2], lien)

print("8. un stub ParaTV (adresse qui change) n'est jamais adopté :")
paratv = "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/streams/ZtgO26U8M1wh/res/vsLoGemTfenj9qX-highest.m3u8"
check("est_stub_rotatif ParaTV", heal.est_stub_rotatif(paratv), True)
check("est_stub_rotatif pool", heal.est_stub_rotatif("http://145.239.5.177/368/index.m3u8"), False)
essayes = []
_vrai = heal.validate_candidate
heal.validate_candidate = lambda u: essayes.append(u) or _vrai(u)
rep = heal.find_replacement("LCI.fr", "LCI",
                            "https://raw.githubusercontent.com/pinkisso/mored/refs/heads/main/res/26-1/lci1.m3u8",
                            {"LCI.fr": [(paratv, "15. LCI [720p-tf1.fr]"), (f"{base}/master.m3u8", "LCI")]}, {})
heal.validate_candidate = _vrai
check("le stub ParaTV n'est même pas essayé", paratv in essayes, False)
check("le flux vivant suivant est retenu", rep, f"{base}/master.m3u8")

srv.shutdown()
print("\nRÉSULTAT GLOBAL :", "✅ tout passe" if ok else "❌ ÉCHECS")
sys.exit(0 if ok else 1)
