#!/usr/bin/env bash
#
# check_links.sh — teste chaque flux de TV.m3u et commente les liens morts.
#
# Pourquoi ce script ? La plupart des flux IPTV sont géo-restreints
# (France / Canada). Ils doivent être testés DEPUIS ton réseau : un serveur
# distant (ou un environnement cloud) reçoit des 403/timeout sur des flux qui
# marchent très bien chez toi. Lance donc ce script sur ta machine.
#
# Ce qu'il fait :
#   - teste l'URL de chaque chaîne (suit les redirections, vrai User-Agent VLC)
#   - si le flux est MORT, il préfixe la ligne d'URL par "# HS " (la chaîne est
#     désactivée mais récupérable — rien n'est supprimé)
#   - garde une sauvegarde TV.m3u.bak
#
# Usage :
#   ./check_links.sh                 # teste et commente dans TV.m3u
#   ./check_links.sh -n              # dry-run : affiche seulement le statut
#   ./check_links.sh -f autre.m3u    # cible un autre fichier
#
# Un lien est considéré MORT si curl renvoie un code 000 (connexion
# impossible / timeout), 404, 410, ou 5xx. Les 403 sont GARDÉS par défaut
# (presque toujours du géo-blocage, pas un flux mort) — passe --strict pour
# aussi les traiter comme morts.

set -uo pipefail

FILE="TV.m3u"
DRYRUN=0
STRICT=0
TIMEOUT=12
UA="VLC/3.0.20 LibVLC/3.0.20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRYRUN=1; shift ;;
    -f|--file)    FILE="$2"; shift 2 ;;
    --strict)     STRICT=1; shift ;;
    -t|--timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
done

[[ -f "$FILE" ]] || { echo "Fichier introuvable : $FILE" >&2; exit 1; }

# code mort ?
is_dead() {
  local code="$1"
  case "$code" in
    000|404|410|5??) return 0 ;;
    403) [[ "$STRICT" == "1" ]] && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}

test_url() {
  # tente HEAD puis GET (certains CDN refusent HEAD)
  local url="$1" code
  code=$(curl -A "$UA" -s -o /dev/null -m "$TIMEOUT" -L -w '%{http_code}' "$url" 2>/dev/null)
  if [[ "$code" == "000" || "$code" == "405" ]]; then
    code=$(curl -A "$UA" -s -o /dev/null -m "$TIMEOUT" -L -r 0-1024 -w '%{http_code}' "$url" 2>/dev/null)
  fi
  echo "$code"
}

cp "$FILE" "$FILE.bak"
echo "Sauvegarde : $FILE.bak"
echo "Test des flux (timeout ${TIMEOUT}s, strict=$STRICT)…"
echo

tmp="$(mktemp)"
total=0; dead=0; alive=0; chan=""

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == \#EXTINF* ]]; then
    chan="${line##*,}"
    echo "$line" >> "$tmp"
  elif [[ "$line" =~ ^https?:// ]]; then
    total=$((total+1))
    code=$(test_url "$line")
    if is_dead "$code"; then
      dead=$((dead+1))
      printf '  ❌ %-4s %s\n' "$code" "$chan"
      if [[ "$DRYRUN" == "1" ]]; then
        echo "$line" >> "$tmp"
      else
        echo "# HS [$code] $line" >> "$tmp"
      fi
    else
      alive=$((alive+1))
      printf '  ✅ %-4s %s\n' "$code" "$chan"
      echo "$line" >> "$tmp"
    fi
  else
    echo "$line" >> "$tmp"
  fi
done < "$FILE"

if [[ "$DRYRUN" == "1" ]]; then
  rm -f "$tmp"
  echo
  echo "Dry-run : aucune modification. (testés : $total | vivants : $alive | morts : $dead)"
else
  mv "$tmp" "$FILE"
  echo
  echo "Terminé. Testés : $total | vivants : $alive | commentés HS : $dead"
  echo "Les chaînes mortes sont préfixées '# HS [...]' dans $FILE (restaurables via $FILE.bak)."
fi
