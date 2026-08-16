// Vérifie le suivi de redirections du proxy /api/fr.
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

console.log(fails === 0 ? "\nPROXY : REDIRECTIONS SOUS CONTRÔLE" : `\n${fails} ÉCHEC(S)`);
process.exit(fails === 0 ? 0 : 1);
