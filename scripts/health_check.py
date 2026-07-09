#!/usr/bin/env python3
"""Intelligent health-check for TV.m3u.

Runs on a schedule (see .github/workflows/health-check.yml). For each channel it
does a real HLS probe (manifest + one media segment) and, crucially, is tolerant
of the flaky free-IPTV relays this playlist relies on:

  * A channel is disabled (its URL line prefixed with "# HS ") ONLY after
    FAIL_THRESHOLD *consecutive* failing runs — a single blip never cuts it.
  * Geo-blocks (HTTP 403/451) are NEVER treated as failures. This job runs from
    a GitHub US runner, so CA/US/FR geo-locked feeds legitimately answer 403;
    disabling them would be wrong. (Same convention as check_links.sh.)
  * A disabled channel that answers OK again is automatically re-enabled.

State (consecutive-failure counters) lives in .health/state.json.
The script ALWAYS exits 0 so a dead upstream never turns into a red build / email.
"""
import json
import os
import re
import subprocess
import sys
from urllib.parse import urljoin

UA = "VLC/3.0.20 LibVLC/3.0.20"
FAIL_THRESHOLD = 3            # consecutive dead runs before disabling
HS = "# HS "                  # marker prefix for a disabled URL line
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M3U = os.path.join(ROOT, "TV.m3u")
STATE = os.path.join(ROOT, ".health", "state.json")

DEAD_CODES = {"000", "404", "410", "500", "502", "503", "504", "521", "522", "523"}
GEO_CODES = {"403", "451"}


def curl(url, rng=None, timeout=20, want_body=True):
    body = "/tmp/hc_body" if want_body else os.devnull
    cmd = ["curl", "-sS", "-m", str(timeout), "-A", UA, "-L",
           "--max-filesize", "6000000", "-o", body,
           "-w", "%{http_code}|%{url_effective}"]
    if rng:
        cmd += ["-r", rng]
    cmd.append(url)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 8)
    except subprocess.TimeoutExpired:
        return "000", url, ""
    parts = p.stdout.strip().split("|")
    code, final = (parts + ["000", url])[:2]
    text = ""
    if want_body:
        try:
            with open(body, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read(6000)
        except OSError:
            pass
    return code, final, text


def first_uri(text, base):
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            return urljoin(base, s)
    return None


def classify(url):
    """Return 'ok' | 'geo' | 'dead' by probing manifest then one segment."""
    code, final, body = curl(url)
    if code in GEO_CODES:
        return "geo"
    if "#EXTM3U" not in body:
        return "dead" if code in DEAD_CODES or code == "000" else (
            "ok" if code == "200" else "dead")
    # It's a playlist. Resolve one level deeper to confirm real media is served.
    text, base = body, final
    if "#EXT-X-STREAM-INF" in body:
        var = first_uri(body, base)
        if var:
            c2, f2, b2 = curl(var, timeout=15)
            if c2 in GEO_CODES:
                return "geo"
            if "#EXTM3U" in b2:
                text, base = b2, f2
            elif c2 in DEAD_CODES:
                return "dead"
    seg = first_uri(text, base)
    if not seg:
        return "ok"  # manifest present, no segment resolvable — treat as up
    c3, _, _ = curl(seg, rng="0-1", timeout=12, want_body=False)
    if c3 in ("200", "206"):
        return "ok"
    if c3 in GEO_CODES:
        return "geo"
    return "dead"


def stream_url_lines(lines):
    """Yield (idx, disabled, url) for every stream-URL line following an #EXTINF."""
    for i, line in enumerate(lines):
        if not line.startswith("#EXTINF"):
            continue
        for j in range(i + 1, min(i + 4, len(lines))):
            s = lines[j].strip()
            if re.match(r"^(# HS\s+)?https?://", s):
                disabled = s.startswith("# HS")
                url = re.sub(r"^# HS\s+", "", s).strip()
                yield j, disabled, url
                break


def main():
    with open(M3U, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}

    changed = []
    seen = set()
    for idx, disabled, url in stream_url_lines(lines):
        seen.add(url)
        v = classify(url)
        st = state.setdefault(url, {"fails": 0})
        if v == "ok":
            st["fails"] = 0
            if disabled:
                lines[idx] = url
                changed.append(f"RESTORED  {url}")
        elif v == "geo":
            st["fails"] = 0  # reachable, just geo-blocked from the runner
        else:  # dead
            st["fails"] += 1
            if st["fails"] >= FAIL_THRESHOLD and not disabled:
                lines[idx] = HS + url
                changed.append(f"DISABLED  ({st['fails']} fails) {url}")

    # prune state for URLs no longer in the playlist
    for u in list(state):
        if u not in seen:
            del state[u]

    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, "w"), ensure_ascii=False, indent=1, sort_keys=True)
    with open(M3U, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    if changed:
        print("Changes:")
        for c in changed:
            print("  " + c)
    else:
        print("No channel state changes.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never fail the build over a probe hiccup
        print(f"health_check: non-fatal error: {e}", file=sys.stderr)
    sys.exit(0)
