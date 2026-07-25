/**
 * Tests de /api/deals — normalisation, tri, filtres, repli HTML et handler.
 *
 * RedFlagDeals n'est pas appelé : `fetch` est remplacé par un bouchon. Le but
 * est de figer le contrat rendu au front-end et la tolérance au format amont
 * (l'API du forum n'est pas documentée et peut changer sans prévenir).
 *
 *   node scripts/test_deals.mjs      (Node >= 22 : détection auto d'ESM pour api/deals.js)
 */

import {normalizeTopic, hotScore, sortDeals, applyQuery, parseHtmlListing} from "../api/deals.js";
let fail=0; const ok=(c,m)=>{ if(!c){console.log("FAIL:",m);fail++;} else console.log("ok:",m); };

const now = new Date();
const t = {
  topic_id: 2734501,
  title: "[Amazon.ca] Sony WH-1000XM5 Casque &amp; Bluetooth $299.99 (was $499.99)",
  web_path: "/amazon-ca-sony-wh1000xm5-2734501/",
  post_time: new Date(now-3*3600e3).toISOString(),
  total_replies: 42, total_views: 15320,
  author: {username: "dealhunter99"},
  votes: {total_up: 61, total_down: 4},
  offer: {dealer_name:"Amazon.ca", price:"$299.99", list_price:"$499.99",
          url:"https://www.amazon.ca/dp/B09XS7JWHH?tag=x", expires_at:null}
};
const d = normalizeTopic(t);
ok(d.id===2734501,"id");
ok(d.title==="Sony WH-1000XM5 Casque & Bluetooth $299.99 (was $499.99)","titre nettoyé du [marchand] + entités: "+d.title);
ok(d.dealer==="Amazon.ca","dealer");
ok(d.price===299.99 && d.listPrice===499.99,"prix "+d.price+"/"+d.listPrice);
ok(d.discountPct===40,"rabais calculé = "+d.discountPct);
ok(d.votes===57,"votes nets");
ok(d.domain==="amazon.ca","domaine "+d.domain);
ok(d.url==="https://forums.redflagdeals.com/amazon-ca-sony-wh1000xm5-2734501/","url absolue");
ok(d.expired===false,"non expiré");

// dealer absent -> extrait du titre ; prix format FR ; expiré
const d2 = normalizeTopic({topic_id:1, title:"[Costco] Pneus 1 299,99 $", post_time:now.toISOString(),
  offer:{price:"1 299,99 $", expires_at:"2020-01-01T00:00:00Z"}, votes:{}});
ok(d2.dealer==="Costco","dealer depuis le titre");
ok(d2.price===1299.99,"prix FR -> "+d2.price);
ok(d2.expired===true,"expiré par date");

// robustesse
ok(normalizeTopic(null)===null && normalizeTopic({})===null && normalizeTopic({topic_id:5})===null,"entrées invalides -> null");
const d3 = normalizeTopic({topic_id:7,title:"Nu"});
ok(d3.price===null && d3.votes===0 && d3.url.includes("topic-7"),"champs manquants tolérés");

// tri : à votes égaux le plus récent gagne en 'hot'
const A={...d, id:10, votes:50, replies:10, createdAt:new Date(now-2*3600e3).toISOString()};
const B={...d, id:11, votes:50, replies:10, createdAt:new Date(now-72*3600e3).toISOString()};
ok(hotScore(A)>hotScore(B),"hotScore favorise le frais");
ok(sortDeals([B,A],"hot")[0].id===10,"tri hot");
ok(sortDeals([{...A,votes:1},{...B,votes:99}],"votes")[0].votes===99,"tri votes");
ok(sortDeals([{...A,discountPct:5},{...B,discountPct:70}],"discount")[0].discountPct===70,"tri discount");

// filtres
const pool=[{...d,id:1,title:"AirPods Pro 2",dealer:"Best Buy",domain:"bestbuy.ca",price:249,discountPct:20,expired:false},
            {...d,id:2,title:"Pneus hiver",dealer:"Costco",domain:"costco.ca",price:800,discountPct:5,expired:false},
            {...d,id:3,title:"AirPods Max",dealer:"Amazon.ca",domain:"amazon.ca",price:600,discountPct:30,expired:true}];
ok(applyQuery(pool,{q:"airpods",hideExpired:true}).length===1,"recherche + masque expirés");
ok(applyQuery(pool,{q:"airpods pro",hideExpired:true})[0].id===1,"recherche multi-termes");
ok(applyQuery(pool,{dealer:"costco",hideExpired:true})[0].id===2,"filtre marchand");
ok(applyQuery(pool,{maxPrice:300,hideExpired:true}).length===1,"filtre prix max");
ok(applyQuery(pool,{minDiscount:25,hideExpired:false}).length===1,"filtre rabais min");

// fallback HTML
const html=`<ul><li class="row topic first_unread">
  <h3><a class="topic_title_link" href="/costco-pneus-2734999/"><span class="topictitle_retailer">Costco</span> Pneus Michelin 30% off</a></h3>
  <dl class="post_voting"><dt class="total_count">88</dt></dl>
  <div class="posts">17</div><div class="views">4,201</div>
  <span class="thread_meta_author">bobqc</span><time datetime="2026-07-25T10:00:00+00:00">x</time>
  <a class="deal_link" href="https://www.costco.ca/x.html">lien</a>
</li><li class="row topic"><h3><a class="topic_title_link" href="/bb-tv-2735000/">TV LG 65&quot; $799</a></h3>
  <dl class="post_voting"><dt class="total_count">12</dt></dl></li></ul>`;
const raw = parseHtmlListing(html);
ok(raw.length===2,"2 sujets parsés du HTML, obtenu "+raw.length);
const h1 = normalizeTopic(raw[0]);
ok(h1.dealer==="Costco" && h1.votes===88 && h1.replies===17 && h1.views===4201,"HTML->normalisé: "+JSON.stringify([h1.dealer,h1.votes,h1.replies,h1.views]));
ok(h1.dealUrl==="https://www.costco.ca/x.html" && h1.author==="bobqc","lien marchand + auteur");
ok(normalizeTopic(raw[1]).title==='TV LG 65" $799',"titre HTML sans marchand + entités");
ok(parseHtmlListing("<html>rien</html>").length===0,"HTML inattendu -> 0 sans planter");


console.log("\n--- handler ---");
const mk=(i,extra={})=>({topic_id:i,title:`[Shop${i%3}] Produit ${i}`,web_path:`/p-${i}/`,
  post_time:new Date(Date.now()-i*3600e3).toISOString(),total_replies:i,total_views:i*10,
  author:{username:"u"+i},votes:{total_up:100-i,total_down:0},
  offer:{dealer_name:"Shop"+(i%3),price:`$${i+9}.99`,list_price:`$${(i+9)*2}.99`,url:`https://shop${i%3}.ca/p/${i}`},...extra});

let calls=[];
globalThis.fetch = async (url) => {
  calls.push(url);
  const page = Number(new URL(url).searchParams.get("page")||1);
  const topics = Array.from({length:40},(_,k)=>mk((page-1)*40+k+1));
  return {ok:true,status:200,json:async()=>({pager:{},topics})};
};
const {default:handler} = await import("../api/deals.js");
const call = (qs) => handler({url:"https://x.vercel.app/api/deals"+qs});


let r = await call("?sort=hot&per_page=10");
let j = JSON.parse(await r.text());
ok(r.status===200,"200");
ok(r.headers.get("cache-control").includes("s-maxage=300"),"cache CDN");
ok(r.headers.get("access-control-allow-origin")==="*","CORS");
ok(calls.length===3,"3 pages amont ratissées pour un tri: "+calls.length);
ok(j.deals.length===10 && j.total===120,"10 sur 120");
ok(j.hasMore===true,"hasMore");
ok(j.dealers.length===3 && j.dealers[0].count===40,"facettes marchands");
ok(j.source==="api","source api");
ok(new Set(j.deals.map(d=>d.id)).size===10,"pas de doublon");

calls=[]; r = await call("?sort=new&per_page=10&page=2");
j = JSON.parse(await r.text());
ok(calls.length===1 && calls[0].includes("page=2"),"tri 'new' -> pagination amont directe");
ok(j.deals.length===10,"10 items page 2");

// pagination cohérente sur un tri: page1 et page2 disjointes
const p1 = JSON.parse(await (await call("?sort=votes&per_page=5&page=1")).text()).deals.map(d=>d.id);
const p2 = JSON.parse(await (await call("?sort=votes&per_page=5&page=2")).text()).deals.map(d=>d.id);
ok(p1.filter(x=>p2.includes(x)).length===0,"pages disjointes");

// recherche
j = JSON.parse(await (await call("?q=Produit%2042")).text());
ok(j.total===1 && j.deals[0].title==="Produit 42","recherche serveur");

// bornes
j = JSON.parse(await (await call("?per_page=999&page=999&sort=bidon")).text());
ok(j.perPage===40 && j.page===20 && j.sort==="hot","params bornés/validés");

// debug
j = JSON.parse(await (await call("?debug=1")).text());
ok(j.sampleKeys.includes("topic_id") && j.normalizedSample.id>0,"mode debug");

// API HS -> repli HTML
globalThis.fetch = async (url) => url.includes("/api/topics")
  ? {ok:false,status:403,json:async()=>({})}
  : {ok:true,status:200,text:async()=>`<li class="row topic"><a class="topic_title_link" href="/x-123456/">Deal de secours</a><dt class="total_count">9</dt></li>`};
j = JSON.parse(await (await call("?sort=hot")).text());
ok(j.source==="html" && j.deals[0].title==="Deal de secours","repli HTML quand l'API renvoie 403");

// tout HS -> 502 explicite
globalThis.fetch = async () => ({ok:false,status:503,json:async()=>({}),text:async()=>""});
r = await call("?sort=hot"); j = JSON.parse(await r.text());
ok(r.status===502 && j.error==="source_indisponible" && Array.isArray(j.deals),"502 propre quand tout tombe");

// upstream qui plante (timeout/JSON invalide) ne doit pas throw
globalThis.fetch = async () => { throw new Error("boom"); };
r = await call("?sort=new"); ok(r.status===502,"exception amont -> 502, pas de crash");


console.log("\n--- robustesse des liens ---");
{
  const bad = normalizeTopic({topic_id:9, title:"[X] Piège", web_path:"javascript:alert(1)",
    offer:{url:"javascript:alert(1)", thumbnail:"data:text/html,<script>x</script>"}, votes:{}});
  ok(!bad.url.startsWith("javascript:"), "web_path hostile neutralisé -> "+bad.url);
  ok(bad.dealUrl===null, "lien marchand javascript: rejeté");
  ok(bad.image===null, "image data: rejetée");
  const good = normalizeTopic({topic_id:10, title:"ok", offer:{url:"//cdn.example.com/x.jpg"}, votes:{}});
  ok(good.dealUrl==="https://cdn.example.com/x.jpg", "URL protocol-relative résolue en https");
}

console.log(fail? `\n${fail} ÉCHEC(S)`:"\nTOUS LES TESTS PASSENT");
process.exit(fail?1:0);
