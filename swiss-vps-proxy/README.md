# Proxy netplus — VPS suisse 🇨🇭

netplus.ch n'accepte que les **IP suisses**. Vercel n'a pas de région CH, donc
ce proxy doit tourner sur un **VPS en Suisse**. Une fois en place, tes chaînes
netplus (Canal J, M6, Gulli, TF1, France 2…) marchent **propres, sans DRM et
sans lag**.

## 1. Prendre un petit VPS suisse (~3-6 €/mois)
- **Infomaniak** (Public Cloud, Genève) — https://www.infomaniak.com
- **Exoscale** (CH-GVA / CH-DK) — https://www.exoscale.com
- **Hostpoint / Nine.ch / Plesk CH** — autres options suisses
- Le plus petit modèle suffit (1 vCPU, 1 Go RAM). **Il faut juste que l'IP soit en Suisse.**

## 2. Installer et lancer (sur le VPS)
```bash
# Node 18+ (Debian/Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Récupérer ce dossier (ou copier server.js)
mkdir -p ~/netplus && cd ~/netplus
# colle server.js ici (depuis ce repo : swiss-vps-proxy/server.js)

# (optionnel mais conseillé) une clé pour que personne d'autre n'utilise ton proxy
export KEY="choisis-un-secret"

# lancer en arrière-plan (survit à la déconnexion)
sudo npm i -g pm2
KEY="$KEY" pm2 start server.js --name netplus
pm2 save && pm2 startup   # démarrage auto au reboot
```
Ouvre le port 8080 dans le firewall du VPS si besoin (`ufw allow 8080`).

Test : `http://TON_IP_VPS:8080/healthz` doit afficher `ok`.
Puis : `http://TON_IP_VPS:8080/ch/canalj` doit lancer Canal J.

## 3. Me donner l'adresse
Envoie-moi `http://TON_IP_VPS:8080` (et la KEY si tu en as mis une) et je
câble automatiquement les chaînes netplus dans `TV.m3u`, du genre :
```
http://TON_IP_VPS:8080/ch/canalj
http://TON_IP_VPS:8080/ch/m6hd
http://TON_IP_VPS:8080/ch/gulli
```

## Chaînes netplus disponibles (slugs)
`tf1hd` · `france2` · `france3` · `france4` · `france5` · `m6hd` · `w9` ·
`6ter` · `nt1` (TFX) · `hd1` (TF1 Séries Films) · `tmc` · `canalj` · `gulli` ·
`canalplusclair` · `arte` · `mtvfrance` · `kto` … (et plein d'internationales :
`rai1`, `bbc2`, `la7`, `tveinternacional`…)

> Astuce : le slug = le nom dans l'URL netplus
> `https://viamotionhsi.netplus.ch/live/eds/<slug>/browser-HLS8/<slug>.m3u8`

## Sécurité / légalité
- Mets une `KEY` pour ne pas laisser un proxy ouvert au monde entier.
- Tu relaies des flux pour ton usage perso ; à toi de rester dans les clous de
  ce que tu as le droit de regarder.

## Bonus : nom de domaine + HTTPS (optionnel)
Si ton lecteur refuse le `http://`, mets un reverse-proxy Caddy devant
(`caddy reverse-proxy --to :8080` avec un domaine) pour avoir du `https://`.
