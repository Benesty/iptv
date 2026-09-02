// Vérifie le proxy /api/fr : suivi des redirections, et relecture des stubs à
// jetons (mode « &v=<n> », repli fb=).
//
// On n'écrit pas une copie des fonctions : on extrait le TEXTE SOURCE de
// api/fr.js et on l'exécute avec un `fetch` simulé. Ce qui est testé est donc
// bien le code déployé, pas une paraphrase.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../api/fr.js", import.meta.url), "utf8");
const grab = (name) => {
  // `async` fait partie de la déclaration : l'oublier casserait le `await`.
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`fonction ${name} introuvable`);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error("accolade non fermée");
};

const MAX = src.match(/const MAX_REDIRECTS = (\d+)/)[1];
const code = `
  const MAX_REDIRECTS = ${MAX};
  ${grab("isBlockedTarget")}
  ${grab("fetchFollowingSafely")}
  export { fetchFollowingSafely, isBlockedTarget, MAX_REDIRECTS };
`;
const mod = await import("data:text/javascript," + encodeURIComponent(code));

// fetch simulé : une carte URL -> réponse (302 vers ailleurs, ou 200).
let hops = [];
globalThis.fetch = async (url) => {
  hops.push(url);
  const r = ROUTES[url];
  if (!r) return new Response("ok", { status: 200 });
  return new Response(null, { status: 302, headers: { location: r } });
};
let ROUTES = {};

let fails = 0;
const check = (label, cond, extra) => {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label} ${JSON.stringify(extra ?? "")}`);
  if (!cond) fails++;
};

console.log("A. Redirections");
// 1. Redirection normale entre CDN : elle doit passer.
ROUTES = { "https://cdn-a.example/x.m3u8": "https://cdn-b.example/y.m3u8" };
hops = [];
let res = await mod.fetchFollowingSafely("https://cdn-a.example/x.m3u8", {}, undefined);
check("Une redirection entre CDN est suivie", res.status === 200 && hops.length === 2, hops);

// 2. Redirection vers une adresse interne : refusée.
for (const cible of [
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:8080/admin",
  "http://10.0.0.5/",
  "http://192.168.1.1/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::]/",
  "http://[fd00::1]/",
  "http://[fe80::1]/",
  "http://[fe90::1]/",
  "http://[feb0::1]/",
  "file:///etc/passwd",
]) {
  ROUTES = { "https://cdn-a.example/x.m3u8": cible };
  let err = "";
  try {
    await mod.fetchFollowingSafely("https://cdn-a.example/x.m3u8", {}, undefined);
  } catch (e) {
    err = e.message;
  }
  check(`Redirection vers ${cible} refusée`, /interdite/.test(err), err || "AUCUNE ERREUR");
}

// 3. Boucle de redirections : bornée.
ROUTES = {};
for (let i = 0; i < 20; i++) ROUTES[`https://a.example/${i}`] = `https://a.example/${i + 1}`;
hops = [];
let err = "";
try {
  await mod.fetchFollowingSafely("https://a.example/0", {}, undefined);
} catch (e) {
  err = e.message;
}
check("Une chaîne de redirections est bornée", /trop de redirections/.test(err), err);
check(`…à ${MAX} sauts au plus`, hops.length === Number(MAX) + 1, { hops: hops.length });

// 4. Redirection relative : résolue contre l'URL courante, pas la racine.
ROUTES = { "https://cdn-a.example/live/x.m3u8": "seg/1.ts" };
hops = [];
await mod.fetchFollowingSafely("https://cdn-a.example/live/x.m3u8", {}, undefined);
check("Une redirection relative est résolue correctement", hops[1] === "https://cdn-a.example/live/seg/1.ts", hops);

/* ------------------------------------------------------------------ *
 * B. Stubs à jetons : relecture « &v=<n> », expiration, repli
 * ------------------------------------------------------------------ */
console.log("\nB. Stubs à jetons (mode v=, repli fb=)");
const PLAYLIST = src.match(/const PLAYLIST =\s*"([^"]+)"/)[1];
const code2 = `
  const PLAYLIST = ${JSON.stringify(PLAYLIST)};
  const UA = "test"; const TIMEOUT_MS = 2000; const RESOLVE_TTL_MS = 45_000;
  const memo = new Map(); const lastGood = new Map();
  ${grab("isBlockedTarget")}
  ${grab("memoized")}
  ${grab("resolveParaTV")}
  ${grab("fetchStub")}
  ${grab("urisOf")}
  ${grab("tokenExp")}
  ${grab("earliestExp")}
  ${grab("rewriteStub")}
  ${grab("resolveStub")}
  ${grab("fallbackTarget")}
  export { memo, lastGood, urisOf, tokenExp, earliestExp, rewriteStub, resolveStub, fallbackTarget };
`;
const st = await import("data:text/javascript," + encodeURIComponent(code2));

// Jeton JWT avec une expiration donnée (secondes epoch), comme chez TF1.
const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (exp) => `eyJhbGciOiJIUzI1NiJ9.${b64url(JSON.stringify({ cip: "1.2.3.4", exp }))}.sig`;
const NOW = Math.floor(Date.now() / 1000);
const stubText = (exp, cdn = "alive-tf1-hls.cdn-0.diff.tf1.fr") => [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="fra",URI="https://${cdn}/${jwt(exp)}/audio.m3u8"`,
  `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="fra",URI="https://${cdn}/${jwt(exp)}/sub.m3u8"`,
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="a",SUBTITLES="s"',
  `https://${cdn}/${jwt(exp)}/720p.m3u8`,
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="a"',
  "relative/360p.m3u8",
  "",
].join("\n");

// 1. urisOf : ordre du document, attributs URI= inclus, relatif résolu.
const uris = st.urisOf(stubText(NOW + 3600), "https://raw.githubusercontent.com/P/T/main/streams/x/res/a.m3u8");
check("urisOf : 4 URI dans l'ordre du document", uris.length === 4 && uris[0].endsWith("/audio.m3u8") && uris[1].endsWith("/sub.m3u8") && uris[2].endsWith("/720p.m3u8"), uris);
check("urisOf : une URI relative est résolue contre le stub", uris[3] === "https://raw.githubusercontent.com/P/T/main/streams/x/res/relative/360p.m3u8", uris[3]);

// 2. rewriteStub : mêmes numéros que urisOf, lignes de commentaire conservées.
const rw = st.rewriteStub(stubText(NOW + 3600), "https://p.example/api/fr?id=TF1.fr");
const vlinks = [...rw.matchAll(/https:\/\/p\.example\/api\/fr\?id=TF1\.fr&v=(\d+)/g)].map((m) => Number(m[1]));
check("rewriteStub : v=0..3 dans l'ordre", JSON.stringify(vlinks) === "[0,1,2,3]", vlinks);
check("rewriteStub : les attributs restent autour de URI=", /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="fra",URI="https:\/\/p\.example\/api\/fr\?id=TF1\.fr&v=0"/.test(rw), rw.split("\n")[2]);
check("rewriteStub : aucun jeton ne subsiste dans le manifeste servi", !rw.includes("eyJ"), "");

// 3. tokenExp : les quatre formes de jetons, et null sans jeton.
check("tokenExp : JWT TF1", st.tokenExp(`https://alive-tf1-hls.cdn-0.diff.tf1.fr/${jwt(1788363253)}/x.m3u8`) === 1788363253);
check("tokenExp : France TV (base64 exp=…~acl=…)", st.tokenExp("https://live-ssai-p.ftven.fr/" + Buffer.from("exp=1788369615~acl=%2f*~hmac=abc").toString("base64") + "/dai/v.m3u8") === 1788369615);
check("tokenExp : Canal+ (__token__exp%3D…)", st.tokenExp("https://hls-m015.canalplus-cdn.net/__token__exp%3D1788380360~acl%3D%2Flive%2F*~hmac%3Dabc/live/x.m3u8") === 1788380360);
check("tokenExp : Akamai (hdnts=exp=…)", st.tokenExp("https://cdn.akamaized.net/x.m3u8?hdnts=exp=1788380000~acl=/*~hmac=abc") === 1788380000);
check("tokenExp : null sans jeton", st.tokenExp("http://151.80.18.177:86/TF1_HD/index.m3u8") === null);
check("earliestExp : la plus proche", st.earliestExp([`https://x/${jwt(200)}/a`, `https://x/${jwt(100)}/b`, "https://x/c"]) === 100);

// 4. fallbackTarget : http(s) + .m3u8 + pas interne, rien d'autre.
check("fallbackTarget : accepte un manifeste http", st.fallbackTarget("http://151.80.18.177:86/TF1_HD/index.m3u8") === "http://151.80.18.177:86/TF1_HD/index.m3u8");
check("fallbackTarget : refuse une page web (redirection ouverte)", st.fallbackTarget("https://evil.example/login") === null);
check("fallbackTarget : refuse file://", st.fallbackTarget("file:///etc/passwd.m3u8") === null);
check("fallbackTarget : refuse une cible interne", st.fallbackTarget("http://169.254.169.254/x.m3u8") === null);
check("fallbackTarget : refuse le vide", st.fallbackTarget(null) === null && st.fallbackTarget("") === null);

// 5. resolveStub avec fetch simulé : playlist ParaTV -> stub -> URI.
const RAW = "https://raw.githubusercontent.com/Paradise-91/ParaTV/main/streams";
let FILES = {};
let calls = [];
globalThis.fetch = async (url) => {
  const u = String(url).split("?")[0];
  calls.push(u);
  if (u in FILES) return new Response(FILES[u], { status: 200 });
  return new Response("nope", { status: 404 });
};
const playlist = (folder) => `#EXTM3U\n#EXTINF:-1 tvg-id="TF1.fr",TF1\n${RAW}/${folder}/res/tf1.m3u8\n#EXTINF:-1 tvg-id="TMC.fr",TMC\n${RAW}/${folder}/res/tmc.m3u8\n`;
FILES = { [PLAYLIST]: playlist("D1"), [`${RAW}/D1/res/tf1.m3u8`]: stubText(NOW + 3600) };
let r = await st.resolveStub("TF1.fr", null);
check("resolveStub : id= -> stub -> 4 URI, jeton lu", !r.error && r.uris.length === 4 && r.exp === NOW + 3600, r.error);
calls = [];
r = await st.resolveStub("TF1.fr", null);
check("resolveStub : la relecture vient du cache (aucun fetch)", calls.length === 0 && !r.error, calls);

// 6. Rotation ParaTV : dossier D1 supprimé, playlist déjà sur D2 -> suivi.
st.memo.delete("stub:" + `${RAW}/D1/res/tf1.m3u8`);
FILES = { [PLAYLIST]: playlist("D2"), [`${RAW}/D2/res/tf1.m3u8`]: stubText(NOW + 7200) };
r = await st.resolveStub("TF1.fr", null);
check("resolveStub : dossier renouvelé -> playlist relue -> nouveau stub", !r.error && r.exp === NOW + 7200, r);

// 7. Stub disparu ET playlist pas encore rafraîchie (cache GitHub) -> dernier stub valide.
st.memo.clear();
FILES = { [PLAYLIST]: playlist("D2") }; // D2 introuvable, rien de neuf
r = await st.resolveStub("TF1.fr", null);
check("resolveStub : stub introuvable -> dernier stub encore valide", !r.error && r.exp === NOW + 7200, r);

// 8. Jeton expiré dans le stub frais, et dernier bon expiré aussi -> erreur nommée.
st.memo.clear();
st.lastGood.clear();
FILES = { [PLAYLIST]: playlist("D3"), [`${RAW}/D3/res/tf1.m3u8`]: stubText(NOW - 600) };
r = await st.resolveStub("TF1.fr", null);
check("resolveStub : jeton expiré -> erreur explicite", /expiré depuis 10 min/.test(r.error || ""), r);

// 9. id absent de la playlist -> erreur, rien en cache.
st.memo.clear();
r = await st.resolveStub("Inconnue.fr", null);
check("resolveStub : id inconnu -> erreur", /introuvable/.test(r.error || ""), r);

// 10. Mode u= (stub France TV à URL fixe) : même mécanique sans playlist.
st.memo.clear();
const FTV = `${RAW}/francetv/res/france-2-highest.m3u8`;
FILES = { [FTV]: stubText(NOW + 1800, "live-ssai-p.ftven.fr") };
calls = [];
r = await st.resolveStub(null, FTV);
check("resolveStub : u= -> stub lu directement, sans la playlist", !r.error && r.uris.length === 4 && !calls.includes(PLAYLIST), calls);

console.log(fails === 0 ? "\nPROXY : TOUT PASSE" : `\n${fails} ÉCHEC(S)`);
process.exit(fails === 0 ? 0 : 1);
