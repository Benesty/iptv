/**
 * Agrégateur de deals — RedFlagDeals « Hot Deals » (forum 9), normalisé en JSON.
 *
 * Sert de back-end au site /deals : le navigateur ne peut pas appeler
 * forums.redflagdeals.com directement (pas de CORS), et on veut en profiter
 * pour normaliser un format d'entrée instable en un schéma stable.
 *
 *   /api/deals?sort=hot&page=1&per_page=30
 *   /api/deals?q=airpods&dealer=amazon
 *   /api/deals?debug=1        -> diagnostic de la source amont
 *
 * Deux sources, dans l'ordre :
 *   1. l'API JSON du forum (/api/topics) — structurée, c'est la voie normale ;
 *   2. à défaut (403/500/format changé), le HTML de la page de listing, parsé
 *      au régex. Dégradé mais ça garde le site debout quand l'API bouge.
 */

export const config = { runtime: "edge", regions: ["iad1"] };

const FORUM_ID = 9; // Hot Deals
const API_URL = "https://forums.redflagdeals.com/api/topics";
const HTML_URL = "https://forums.redflagdeals.com/hot-deals-f9/";
const BASE = "https://forums.redflagdeals.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TIMEOUT_MS = 12000;

const MAX_PER_PAGE = 40; // limite de l'API amont
const RANK_PAGES = 3; // pages amont ratissées pour les tris « populaires »

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function firstOf(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toInt(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// « $1,299.99 » / « 1299,99 $ » / « 1299.99 » -> 1299.99
function toMoney(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/\s/g, "").match(/-?[\d.,]+/);
  if (!m) return null;
  let s = m[0];
  // format FR « 1 299,99 » : la virgule est le séparateur décimal
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toIso(v) {
  if (!v) return null;
  if (typeof v === "number") {
    // epoch en secondes ou millisecondes
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Les liens viennent de contenu posté par des membres : on n'émet que du
// http(s). Sans ce filtre un « javascript: » remonterait tel quel dans un
// href de la page.
function absUrl(u) {
  if (!u || typeof u !== "string") return null;
  try {
    const url = new URL(u, BASE);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

// Le domaine marchand sert de logo (favicon) et de filtre côté client.
function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Les titres RFD sont préfixés du marchand : « [Amazon.ca] Sony XM5 $299 ».
 * On récupère le marchand quand l'API ne le donne pas, et on nettoie le titre
 * pour que la carte n'affiche pas deux fois la même info.
 */
function splitDealer(rawTitle) {
  const title = decodeEntities(rawTitle || "");
  const m = title.match(/^\s*\[([^\]]{1,60})\]\s*(.+)$/);
  if (m) return { dealer: m[1].trim(), title: m[2].trim() };
  return { dealer: null, title };
}

/* ------------------------------------------------------------------ *
 * Normalisation : schéma amont instable -> schéma stable pour le front
 * ------------------------------------------------------------------ */

export function normalizeTopic(t) {
  if (!t || typeof t !== "object") return null;

  const id = toInt(firstOf(t, ["topic_id", "id", "threadid"]));
  const rawTitle = firstOf(t, ["title", "topic_title", "subject"]);
  if (!id || !rawTitle) return null;

  const offer = (typeof t.offer === "object" && t.offer) || {};
  const votes = (typeof t.votes === "object" && t.votes) || {};
  const author = (typeof t.author === "object" && t.author) || {};

  const parsed = splitDealer(rawTitle);
  const dealer =
    decodeEntities(String(firstOf(offer, ["dealer_name", "dealer", "retailer"]) || "")) ||
    parsed.dealer ||
    null;

  const dealUrl = absUrl(firstOf(offer, ["url", "dealer_link", "link", "offer_url"]));
  const price = toMoney(firstOf(offer, ["price", "sale_price", "deal_price"]));
  const listPrice = toMoney(firstOf(offer, ["list_price", "retail_price", "was_price", "msrp"]));

  let discountPct = toInt(firstOf(offer, ["discount_percentage", "discount_percent", "savings_percentage"]));
  if (!discountPct && price != null && listPrice != null && listPrice > 0 && price < listPrice) {
    discountPct = Math.round((1 - price / listPrice) * 100);
  }
  if (discountPct < 0 || discountPct > 99) discountPct = 0;

  const up = toInt(firstOf(votes, ["total_up", "up", "ups", "total_positive"]));
  const down = toInt(firstOf(votes, ["total_down", "down", "downs", "total_negative"]));

  const createdAt = toIso(firstOf(t, ["post_time", "created_at", "first_post_time", "posted"]));
  const lastPostAt = toIso(firstOf(t, ["last_post_time", "updated_at", "last_post"]));

  const status = toInt(firstOf(t, ["status"]));
  const expiresAt = toIso(firstOf(offer, ["expires_at", "expiry_date", "expires"]));
  const expired =
    Boolean(firstOf(offer, ["expired"])) ||
    status === 2 ||
    (expiresAt != null && Date.parse(expiresAt) < Date.now());

  return {
    id,
    title: parsed.title || decodeEntities(rawTitle),
    url: absUrl(firstOf(t, ["web_path", "url", "permalink"])) || `${BASE}/topic-${id}/`,
    dealUrl,
    domain: hostOf(dealUrl),
    dealer,
    price,
    listPrice,
    currency: "CAD",
    discountPct,
    image: absUrl(firstOf(offer, ["thumbnail", "image", "image_url", "photo"])),
    votesUp: up,
    votesDown: down,
    votes: up - down,
    replies: toInt(firstOf(t, ["total_replies", "replies", "posts"])),
    views: toInt(firstOf(t, ["total_views", "views"])),
    author: decodeEntities(String(firstOf(author, ["username", "name", "author_name"]) || "")) || null,
    createdAt,
    lastPostAt,
    expiresAt,
    expired,
    sticky: Boolean(firstOf(t, ["sticky", "is_sticky"])),
  };
}

/**
 * Score « populaire » : le net des votes, amorti par l'âge. Sans amortissement
 * la première page serait figée sur les deals d'il y a trois jours ; avec, un
 * deal frais qui monte vite passe devant.
 */
export function hotScore(deal, now = Date.now()) {
  const ageH = deal.createdAt ? Math.max(0, (now - Date.parse(deal.createdAt)) / 3.6e6) : 48;
  const engagement = deal.votes + Math.min(deal.replies, 200) * 0.15;
  return engagement / Math.pow(ageH + 2, 0.45);
}

/* ------------------------------------------------------------------ *
 * Source 1 — API JSON du forum
 * ------------------------------------------------------------------ */

async function fetchJsonPage(page) {
  const url = `${API_URL}?forum_id=${FORUM_ID}&per_page=${MAX_PER_PAGE}&page=${page}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json", referer: HTML_URL },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, topics: [] };
    const data = await res.json();
    const topics = Array.isArray(data) ? data : firstOf(data, ["topics", "results", "data"]) || [];
    return { ok: Array.isArray(topics), status: res.status, topics: Array.isArray(topics) ? topics : [] };
  } catch (e) {
    return { ok: false, status: 0, error: String(e), topics: [] };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Source 2 — repli sur le HTML du listing
 * ------------------------------------------------------------------ */

export function parseHtmlListing(html) {
  const out = [];
  // Un <li class="row topic ..."> par sujet ; on découpe dessus plutôt que de
  // tenter un régex global qui traverserait les frontières de sujets.
  const blocks = String(html || "").split(/<li[^>]+class="[^"]*\btopic\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*topic_title_link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const path = decodeEntities(link[1]);
    const idm = path.match(/(\d{5,})/);
    if (!idm) continue;

    const retailer = block.match(/class="[^"]*topictitle_retailer[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const votes = block.match(/class="[^"]*total_count[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const replies = block.match(/class="[^"]*posts[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const views = block.match(/class="[^"]*views[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const author = block.match(/class="[^"]*thread_meta_author[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const time = block.match(/<(?:time|span)[^>]+datetime="([^"]+)"/i);
    const dealUrl = block.match(/<a[^>]+class="[^"]*deal_link[^"]*"[^>]+href="([^"]+)"/i);

    const rawTitle = stripTags(link[2]);
    if (!rawTitle) continue;

    out.push({
      topic_id: toInt(idm[1]),
      title: retailer ? `[${stripTags(retailer[1])}] ${rawTitle}` : rawTitle,
      web_path: path,
      post_time: time ? time[1] : null,
      total_replies: replies ? toInt(stripTags(replies[1])) : 0,
      total_views: views ? toInt(stripTags(views[1])) : 0,
      author: { username: author ? stripTags(author[1]) : null },
      votes: { total_up: votes ? toInt(stripTags(votes[1])) : 0, total_down: 0 },
      offer: { dealer_name: retailer ? stripTags(retailer[1]) : null, url: dealUrl ? decodeEntities(dealUrl[1]) : null },
    });
  }
  return out;
}

async function fetchHtmlFallback() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HTML_URL, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, topics: [] };
    const topics = parseHtmlListing(await res.text());
    return { ok: topics.length > 0, status: res.status, topics };
  } catch (e) {
    return { ok: false, status: 0, error: String(e), topics: [] };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Filtres + tri
 * ------------------------------------------------------------------ */

export function applyQuery(deals, { q, dealer, maxPrice, minDiscount, hideExpired }) {
  let out = deals;
  if (hideExpired) out = out.filter((d) => !d.expired);
  if (q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    out = out.filter((d) => {
      const hay = `${d.title} ${d.dealer || ""} ${d.domain || ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (dealer) {
    const needle = dealer.toLowerCase();
    out = out.filter((d) => `${d.dealer || ""} ${d.domain || ""}`.toLowerCase().includes(needle));
  }
  if (maxPrice != null) out = out.filter((d) => d.price != null && d.price <= maxPrice);
  if (minDiscount) out = out.filter((d) => d.discountPct >= minDiscount);
  return out;
}

export function sortDeals(deals, sort, now = Date.now()) {
  const byDate = (d) => (d.createdAt ? Date.parse(d.createdAt) : 0);
  const copy = deals.slice();
  switch (sort) {
    case "hot":
      return copy.sort((a, b) => hotScore(b, now) - hotScore(a, now));
    case "votes":
      return copy.sort((a, b) => b.votes - a.votes || byDate(b) - byDate(a));
    case "comments":
      return copy.sort((a, b) => b.replies - a.replies || byDate(b) - byDate(a));
    case "discount":
      return copy.sort((a, b) => b.discountPct - a.discountPct || b.votes - a.votes);
    case "new":
    default:
      return copy.sort((a, b) => byDate(b) - byDate(a));
  }
}

/* ------------------------------------------------------------------ */

export default async function handler(req) {
  const url = new URL(req.url);
  const p = url.searchParams;

  const sort = ["new", "hot", "votes", "comments", "discount"].includes(p.get("sort") || "")
    ? p.get("sort")
    : "hot";
  const page = Math.min(Math.max(toInt(p.get("page")) || 1, 1), 20);
  const perPage = Math.min(Math.max(toInt(p.get("per_page")) || 30, 1), MAX_PER_PAGE);
  const q = (p.get("q") || "").trim().slice(0, 80);
  const dealer = (p.get("dealer") || "").trim().slice(0, 60);
  const maxPrice = p.has("max_price") ? toMoney(p.get("max_price")) : null;
  const minDiscount = toInt(p.get("min_discount"));
  const hideExpired = p.get("expired") !== "1";
  const debug = p.get("debug") === "1";

  // Un tri « nouveautés » sans filtre suit la pagination amont : une page
  // suffit. Dès qu'on trie ou qu'on filtre, il faut un vivier plus large,
  // sinon « le plus voté » ne verrait que les 40 derniers sujets postés.
  const needsPool = sort !== "new" || q || dealer || maxPrice != null || minDiscount;
  const pages = needsPool ? Array.from({ length: RANK_PAGES }, (_, i) => i + 1) : [page];

  let results = await Promise.all(pages.map(fetchJsonPage));
  let source = "api";
  let raw = results.flatMap((r) => r.topics);

  if (!raw.length) {
    const fb = await fetchHtmlFallback();
    if (fb.topics.length) {
      source = "html";
      results = [fb];
      raw = fb.topics;
    }
  }

  if (!raw.length) {
    const upstream = results.map((r) => ({ status: r.status, error: r.error }));
    return json(
      { error: "source_indisponible", message: "RedFlagDeals n'a rien renvoyé.", upstream, deals: [] },
      502
    );
  }

  if (debug) {
    return json({
      source,
      upstream: results.map((r) => ({ status: r.status, ok: r.ok, count: r.topics.length })),
      sampleKeys: Object.keys(raw[0] || {}),
      sampleOfferKeys: Object.keys((raw[0] && raw[0].offer) || {}),
      sample: raw[0],
      normalizedSample: normalizeTopic(raw[0]),
    });
  }

  const seen = new Set();
  const deals = [];
  for (const t of raw) {
    const d = normalizeTopic(t);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    deals.push(d);
  }

  const filtered = applyQuery(deals, { q, dealer, maxPrice, minDiscount, hideExpired });
  const sorted = sortDeals(filtered, sort);

  // Page 1 amont déjà consommée quand on a ratissé plusieurs pages : on
  // découpe nous-mêmes. Sinon la page amont EST la page demandée.
  const slice = needsPool ? sorted.slice((page - 1) * perPage, page * perPage) : sorted.slice(0, perPage);

  const dealers = {};
  for (const d of filtered) {
    const name = d.dealer || d.domain;
    if (name) dealers[name] = (dealers[name] || 0) + 1;
  }

  return json({
    source,
    sort,
    page,
    perPage,
    total: filtered.length,
    hasMore: needsPool ? page * perPage < sorted.length : slice.length === perPage,
    fetchedAt: new Date().toISOString(),
    dealers: Object.entries(dealers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([name, count]) => ({ name, count })),
    deals: slice,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      // Le CDN Vercel absorbe le trafic : RFD ne voit qu'un hit toutes les
      // 5 min par région, et le visiteur a une réponse instantanée.
      "cache-control":
        status === 200
          ? "public, s-maxage=300, stale-while-revalidate=900"
          : "public, s-maxage=30",
      "x-content-type-options": "nosniff",
    },
  });
}
