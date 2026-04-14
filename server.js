const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OKX = "https://www.okx.com/api/v5";
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

const okx = async (path) => {
  const r = await fetch(`${OKX}${path}`, { headers: { Accept: "application/json" } });
  const j = await r.json();
  if (j.code !== "0") throw new Error(j.msg || "OKX error");
  return j.data;
};

const fearGreed = async () => {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    const j = await r.json();
    return { value: parseInt(j.data[0].value), label: j.data[0].value_classification };
  } catch { return { value: 50, label: "Neutral" }; }
};

const dvol = async (coin) => {
  try {
    const r = await fetch(`https://www.deribit.com/api/v2/public/get_index_price?index_name=${coin.toLowerCase()}dvol_usdc`);
    const j = await r.json();
    return j.result?.index_price ?? null;
  } catch { return null; }
};

const weightedATR = (candles) => {
  const weights = [3, 2, 2, 1, 1, 1, 1];
  let wSum = 0, wTot = 0;
  candles.forEach((c, i) => {
    const range = parseFloat(c[2]) - parseFloat(c[3]);
    const w = weights[i] ?? 1;
    wSum += range * w; wTot += w;
  });
  return wSum / wTot;
};

const riskScore = (price, strike, wATR, fundingRate, optType) => {
  const dist = optType === "C" ? (strike - price) / price : (price - strike) / price;
  return Math.round(
    Math.min(40, Math.max(0, dist * 500)) +
    Math.min(20, Math.max(0, (1 - (wATR / price) * 10) * 20)) +
    Math.min(20, Math.max(0, (1 - Math.abs(fundingRate) * 2000) * 20)) + 20
  );
};

const autoAdjust = (products, safeStrike, optType, price, wATR, fundingRate) => {
  const safe = products
    .filter(p => optType === "C" ? p.strikeNum >= safeStrike : p.strikeNum <= safeStrike)
    .sort((a, b) => optType === "C" ? a.strikeNum - b.strikeNum : b.strikeNum - a.strikeNum);
  if (!safe.length) return { product: products[0] ?? null, adjusted: false, iterations: 0 };
  for (let i = 0; i < Math.min(4, safe.length); i++) {
    if (riskScore(price, safe[i].strikeNum, wATR, fundingRate, optType) >= 60 || i === safe.length - 1)
      return { product: safe[i], adjusted: i > 0, iterations: i };
  }
  return { product: safe[0], adjusted: false, iterations: 0 };
};

app.get("/data", async (req, res) => {
  const { coin = "BTC", optType = "C", quoteCcy = "USDG", expiryDays = "3" } = req.query;
  const days = parseInt(expiryDays);
  try {
    const [tickerData, candleData, fundingData, dcdData, fg, dvolVal] = await Promise.all([
      okx(`/market/ticker?instId=${coin}-USDT`),
      okx(`/market/candles?instId=${coin}-USDT&bar=1D&limit=9`),
      okx(`/public/funding-rate?instId=${coin}-USDT-SWAP`),
      okx(`/finance/sfp/dcd/products?baseCcy=${coin}&quoteCcy=${quoteCcy}&optType=${optType}`),
      fearGreed(), dvol(coin),
    ]);
    const price     = parseFloat(tickerData[0].last);
    const change24h = ((price - parseFloat(tickerData[0].open24h)) / parseFloat(tickerData[0].open24h)) * 100;
    const candles   = candleData.slice(1, 8);
    const weights   = [3, 2, 2, 1, 1, 1, 1];
    const ranges    = candles.map((c, i) => ({
      date: new Date(parseInt(c[0])).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      high: parseFloat(c[2]), low: parseFloat(c[3]),
      range: parseFloat(c[2]) - parseFloat(c[3]), weight: weights[i] ?? 1,
    }));
    const simpleATR   = ranges.reduce((s, r) => s + r.range, 0) / ranges.length;
    const wATR        = weightedATR(candles);
    const atr2x       = wATR * 2;
    const fundingRate = parseFloat(fundingData[0].fundingRate);
    const fundingStatus = fundingRate > 0.0001 ? "hot" : fundingRate < 0 ? "negative" : "normal";
    const safeStrike  = optType === "C" ? Math.max(price + atr2x, price * 1.05) : Math.min(price - atr2x, price * 0.95);
    const now = Date.now();
    const products = (dcdData.products || [])
      .map(p => ({
        productId: p.productId, strikeNum: parseFloat(p.strike),
        apy: parseFloat(p.annualizedYield), absYield: parseFloat(p.absYield),
        daysLeft: (parseInt(p.expTime) - now) / 86400000,
        expDate: new Date(parseInt(p.expTime)).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
        minSize: p.minSize,
      }))
      .filter(p => p.daysLeft >= 0.5 && p.daysLeft <= days)
      .sort((a, b) => b.apy - a.apy);
    const { product: rec, adjusted, iterations } = autoAdjust(products, safeStrike, optType, price, wATR, fundingRate);
    const score = rec ? riskScore(price, rec.strikeNum, wATR, fundingRate, optType) : 0;
    const weekHigh = Math.max(...ranges.map(r => r.high));
    const weekLow  = Math.min(...ranges.map(r => r.low));
    const mid = (weekHigh + weekLow) / 2;
    res.json({
      price, change24h, weekHigh, weekLow,
      trend: price > mid * 1.01 ? "bullish" : price < mid * 0.99 ? "bearish" : "neutral",
      simpleATR, wATR, atr2x, safeStrike, fundingRate, fundingStatus,
      fearGreed: fg, dvol: dvolVal, dvolSignal: dvolVal > 70 ? "high" : dvolVal < 40 ? "low" : "normal",
      ranges, products, recommendation: rec, riskScore: score, adjusted, iterations,
      hasSafe: products.some(p => optType === "C" ? p.strikeNum >= safeStrike : p.strikeNum <= safeStrike),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const tgSend = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
  });
};

if (TG_TOKEN && TG_CHAT) {
  cron.schedule("0 0 * * *", async () => {
    try {
      const [b, e2] = await Promise.all([
        fetch(`http://localhost:${PORT}/data?coin=BTC&optType=C&quoteCcy=USDG&expiryDays=3`).then(r => r.json()),
        fetch(`http://localhost:${PORT}/data?coin=ETH&optType=C&quoteCcy=USDG&expiryDays=3`).then(r => r.json()),
      ]);
      const f = n => n?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "-";
      const p = n => n != null ? (n * 100).toFixed(2) + "%" : "-";
      await tgSend([
        "📊 <b>DCD 일일 분석 리포트</b>", "",
        `🟡 <b>BTC-USDG 콜</b>`,
        `• 현재가: $${f(b.price)} (${b.change24h >= 0 ? "+" : ""}${b.change24h?.toFixed(2)}%)`,
        `• 추천: $${f(b.recommendation?.strikeNum)} / APY: ${p(b.recommendation?.apy)} / 리스크: ${b.riskScore}/100`,
        b.adjusted ? "• ⚠ 자동 상향 적용" : "", "",
        `🔵 <b>ETH-USDG 콜</b>`,
        `• 현재가: $${f(e2.price)} (${e2.change24h >= 0 ? "+" : ""}${e2.change24h?.toFixed(2)}%)`,
        `• 추천: $${f(e2.recommendation?.strikeNum)} / APY: ${p(e2.recommendation?.apy)} / 리스크: ${e2.riskScore}/100`,
        e2.adjusted ? "• ⚠ 자동 상향 적용" : "", "",
        `😨 공포탐욕: ${b.fearGreed?.value} (${b.fearGreed?.label})`,
        `📈 BTC DVOL: ${b.dvol?.toFixed(1) ?? "-"}`,
      ].join("\n"));
    } catch (e) { console.error("Cron:", e.message); }
  }, { timezone: "Asia/Seoul" });
}

// ── Embedded HTML Frontend ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>OKX DCD 분석</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;color:#1a1a1a;max-width:500px;margin:0 auto}
.hd{background:#fff;border-bottom:1px solid #eee;padding:10px 14px 8px;position:sticky;top:0;z-index:10}
.tabs{display:flex;gap:5px;margin-bottom:7px}
.tab{flex:1;padding:7px 3px;border-radius:9px;border:1.5px solid #e0e0e0;background:#fff;cursor:pointer;text-align:center;line-height:1.3}
.tab.on{border-color:var(--ac);background:var(--li)}
.tl{font-size:11px;font-weight:700;color:#888}
.tab.on .tl{color:var(--ac)}
.tt{font-size:9px;padding:1px 5px;border-radius:4px;font-weight:700;display:inline-block;margin-top:2px}
.nav{display:flex;border-bottom:1px solid #eee}
.nb{flex:1;padding:8px 4px 6px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;color:#aaa}
.nb.on{border-bottom-color:var(--ac);color:var(--ac)}
.nb span:first-child{font-size:15px}
.nb span:last-child{font-size:9px}
.nb.on span:last-child{font-weight:700}
.ctrl{display:flex;gap:7px;margin-top:8px}
select{flex:1;font-size:12px;padding:7px 8px;border-radius:7px;border:1px solid #ddd;background:#fff}
.rb{flex:2;padding:8px 0;border-radius:7px;border:none;background:var(--ac);color:#fff;font-size:13px;font-weight:700;cursor:pointer}
.rb:disabled{background:#ccc;cursor:not-allowed}
.pg{padding:12px 14px 24px}
.card{background:#fff;border:1px solid #eee;border-radius:12px;padding:13px 15px;margin-bottom:10px}
.ct{font-size:9px;color:#999;text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:8px}
.mg{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px}
.mc{background:#f7f7f7;border-radius:10px;padding:11px 12px}
.ml{font-size:9px;color:#999;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.mv{font-size:16px;font-weight:700;font-family:monospace}
.ms{font-size:10px;color:#aaa;margin-top:2px;font-family:monospace}
.rr{display:flex;align-items:center;gap:7px;margin-bottom:4px;font-size:10px;color:#888;font-family:monospace}
.ro{flex:1;height:4px;background:#f0f0f0;border-radius:2px;overflow:hidden}
.ri{height:100%;border-radius:2px}
.pg-h{display:grid;grid-template-columns:1fr 1fr 54px 32px;gap:4px}
.pr{padding:5px 7px;border-radius:7px;margin-bottom:2px}
.fg2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.rb2{height:4px;background:#f0f0f0;border-radius:2px;margin-top:5px;overflow:hidden}
.rbi{height:100%;border-radius:2px}
.rrb{height:5px;background:#f0f0f0;border-radius:3px;overflow:hidden;margin:8px 0 3px}
.rbl{display:flex;justify-content:space-between;font-size:9px;color:#ccc}
.recrow{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;border-bottom:1px solid #f0f0f0}
.recrow:last-child{border-bottom:none}
.bdg{font-size:11px;font-weight:700;padding:3px 10px;border-radius:6px}
.em{text-align:center;padding:48px 0;color:#aaa}
.ld{text-align:center;padding:40px 0}
.eb{background:#FCEBEB;color:#A32D2D;border-radius:10px;padding:10px 13px;font-size:12px;margin-bottom:12px}
.ts{font-size:10px;color:#bbb;font-family:monospace;text-align:right;margin-bottom:8px}
.adj{background:#FAEEDA;border-radius:7px;padding:7px 10px;margin-bottom:10px;font-size:11px;color:#854F0B;font-weight:600}
.ns{background:#FAEEDA;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:11px;color:#854F0B}
.disc{font-size:11px;color:#ccc;line-height:1.5;margin-top:4px}
/* forms */
.fg{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px}
.fl{font-size:10px;color:#999;margin-bottom:3px}
.fi{width:100%;font-size:12px;padding:6px 8px;border-radius:7px;border:1px solid #ddd}
.sb{width:100%;padding:9px;border:none;border-radius:8px;font-size:13px;font-weight:700;color:#fff;cursor:pointer;background:var(--ac)}
.sb:disabled{background:#ccc;cursor:not-allowed}
/* hist */
.hs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:10px}
.hsi{background:#f7f7f7;border-radius:9px;padding:10px 8px;text-align:center}
.hi{background:#fff;border:1px solid #eee;border-radius:10px;padding:11px 13px;margin-bottom:8px}
.hih{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px}
.ha{display:flex;gap:5px;margin-top:7px}
.hb{flex:1;padding:5px;font-size:11px;border-radius:6px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer}
/* portfolio */
.pfg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.pfc{background:#f7f7f7;border-radius:9px;padding:10px 8px;text-align:center}
.per{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.pi{flex:1;font-size:13px;padding:6px 8px;border-radius:7px;border:1px solid #ddd;font-family:monospace}
.eb2{font-size:11px;background:none;border:1px solid #ddd;border-radius:6px;padding:3px 8px;cursor:pointer}
.ppr{display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid #f0f0f0}
.sr{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #f0f0f0}
/* sim */
.sres{border-radius:12px;padding:13px 15px;margin-bottom:10px;border:1.5px solid}
</style></head><body>
<div id="app"></div>
<script>
const INSTS=[
  {key:"BTC-C",label:"BTC-USDG 콜",tag:"CALL",coin:"BTC",optType:"C",quoteCcy:"USDG",ac:"#BA7517",li:"#FAEEDA",tBg:"#FAEEDA",tC:"#854F0B"},
  {key:"ETH-C",label:"ETH-USDG 콜",tag:"CALL",coin:"ETH",optType:"C",quoteCcy:"USDG",ac:"#185FA5",li:"#E6F1FB",tBg:"#FAEEDA",tC:"#854F0B"},
  {key:"ETH-P",label:"USDG-ETH 풋",tag:"PUT", coin:"ETH",optType:"P",quoteCcy:"USDG",ac:"#3B6D11",li:"#EAF3DE",tBg:"#EAF3DE",tC:"#3B6D11"},
];
const PAGES=[{key:"analysis",icon:"◈",lbl:"분석"},{key:"simulator",icon:"⟿",lbl:"시뮬"},{key:"history",icon:"☰",lbl:"이력"},{key:"portfolio",icon:"◻",lbl:"포트"}];
const HK="dcd-h2",PK="dcd-p2";
const fmt=(n,d=0)=>n==null?"-":Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtP=(n,d=2)=>n==null?"-":(n*100).toFixed(d)+"%";
const fgC=v=>v<30?"#A32D2D":v<50?"#854F0B":v<75?"#3B6D11":"#185FA5";
const SL=s=>s>=70?"safe":s>=50?"moderate":"caution";
const SAF={safe:{l:"안전",bg:"#EAF3DE",c:"#3B6D11"},moderate:{l:"보통",bg:"#FAEEDA",c:"#854F0B"},caution:{l:"주의",bg:"#FCEBEB",c:"#A32D2D"}};
const lsg=(k,d)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}};
const lss=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}};

let S={
  page:"analysis",sk:"BTC-C",exp:3,
  phase:"idle",data:null,err:"",ts:"",
  sm:0,si:1,sIdx:0,
  hist:[],hf:{date:"",coin:"BTC",strike:"",apy:"",note:"",outcome:"pending"},
  pf:{btc:0,eth:0,usdg:0},pfe:false,pfv:{btc:"0",eth:"0",usdg:"0"},
};

function init(){
  S.hist=lsg(HK,[]);
  S.pf=lsg(PK,{btc:0,eth:0,usdg:0});
  S.pfv={btc:String(S.pf.btc),eth:String(S.pf.eth),usdg:String(S.pf.usdg)};
  render();
}

const inst=()=>INSTS.find(i=>i.key===S.sk);

async function runAnalysis(){
  const i=inst();
  S.phase="loading";S.err="";S.data=null;render();
  try{
    const r=await fetch("/data?coin="+i.coin+"&optType="+i.optType+"&quoteCcy="+i.quoteCcy+"&expiryDays="+S.exp);
    if(!r.ok)throw new Error("서버 오류 "+r.status);
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    S.data=d;S.ts=new Date().toLocaleTimeString("ko-KR");S.sIdx=0;S.phase="done";
  }catch(e){S.err=e.message;S.phase="error";}
  render();
}

function addHist(){
  if(!S.hf.strike)return;
  const e={...S.hf,id:Date.now(),createdAt:new Date().toLocaleDateString("ko-KR")};
  S.hist=[e,...S.hist];lss(HK,S.hist);
  S.hf={date:"",coin:"BTC",strike:"",apy:"",note:"",outcome:"pending"};render();
}
function updOut(id,o){S.hist=S.hist.map(h=>h.id===id?{...h,outcome:o}:h);lss(HK,S.hist);render();}
function delHist(id){S.hist=S.hist.filter(h=>h.id!==id);lss(HK,S.hist);render();}
function savePf(){
  S.pf={btc:parseFloat(S.pfv.btc)||0,eth:parseFloat(S.pfv.eth)||0,usdg:parseFloat(S.pfv.usdg)||0};
  lss(PK,S.pf);S.pfe=false;render();
}

function e(tag,attrs,...kids){
  const el=document.createElement(tag);
  for(const[k,v]of Object.entries(attrs||{})){
    if(k==="cls")el.className=v;
    else if(k==="html")el.innerHTML=v;
    else if(k.startsWith("on"))el.addEventListener(k.slice(2).toLowerCase(),v);
    else el.setAttribute(k,v);
  }
  for(const c of kids){
    if(c==null||c===false)continue;
    el.appendChild(typeof c==="string"?document.createTextNode(c):c);
  }
  return el;
}
function cv(el,ac,li){el.style.setProperty("--ac",ac);el.style.setProperty("--li",li);}

function renderAnalysis(){
  const i=inst(),d=S.data,w=e("div",{});
  if(S.phase==="error"){w.appendChild(e("div",{cls:"eb"},e("b",{},"오류: "),S.err));return w;}
  if(S.phase==="idle"){
    w.innerHTML=\`<div class="em"><div style="font-size:36px;margin-bottom:8px">◈</div><div style="font-weight:700;color:#444;margin-bottom:4px;font-size:15px">\${i.label} 분석 준비</div><div style="font-size:12px">가중 ATR · 자동 상향 · 공포탐욕 · DVOL</div></div>\`;
    return w;
  }
  if(S.phase==="loading"){
    w.innerHTML='<div class="ld"><div style="font-size:13px;font-weight:600;color:#555;margin-bottom:6px">OKX 실시간 조회 중...</div>'+
    ["현재가·캔들·펀딩비율","DCD 상품 목록","공포탐욕·Deribit DVOL","가중 ATR·자동 상향 계산"].map(s=>'<div style="font-size:11px;color:#bbb;margin:3px 0">· '+s+'</div>').join("")+'</div>';
    return w;
  }
  if(!d)return w;
  w.appendChild(e("div",{cls:"ts"},"OKX 실시간 · "+S.ts));
  // Metrics
  const mg=e("div",{cls:"mg"});
  [{l:i.coin+" 현재가",v:"$"+fmt(d.price),s:(d.change24h>=0?"+":"")+d.change24h?.toFixed(2)+"% (24h)",sc:d.change24h>=0?"#3B6D11":"#A32D2D",vc:i.ac},
   {l:"가중 ATR",v:"$"+fmt(d.wATR),s:"단순 $"+fmt(d.simpleATR)+" → 2× $"+fmt(d.atr2x)},
   {l:i.optType==="C"?"최소 안전 행사가":"최대 안전 행사가",v:"$"+fmt(d.safeStrike),s:"가중ATR×2 vs 5%"},
   {l:"펀딩 비율(8h)",v:(d.fundingRate>=0?"+":"")+(d.fundingRate*100).toFixed(4)+"%",
    s:d.fundingStatus==="hot"?"과열 주의":d.fundingStatus==="negative"?"약세":"중립",
    sc:d.fundingStatus==="hot"?"#A32D2D":d.fundingStatus==="negative"?"#854F0B":"#3B6D11"},
  ].forEach(m=>{
    mg.appendChild(e("div",{cls:"mc",html:\`<div class="ml">\${m.l}</div><div class="mv" style="color:\${m.vc||"#1a1a1a"}">\${m.v}</div><div class="ms" style="color:\${m.sc||"#aaa"}">\${m.s}</div>\`}));
  });
  w.appendChild(mg);
  // FG+DVOL
  const fg=d.fearGreed;
  w.appendChild(e("div",{cls:"card",html:\`<div class="fg2">
    <div><div class="ct">공포탐욕지수</div>
      <div style="font-size:22px;font-weight:800;color:\${fgC(fg?.value||50)}">\${fg?.value||"-"}</div>
      <div style="font-size:10px;font-weight:600;color:\${fgC(fg?.value||50)}">\${fg?.label||""}</div>
      <div class="rb2"><div class="rbi" style="width:\${fg?.value||0}%;background:\${fgC(fg?.value||50)}"></div></div></div>
    <div><div class="ct">DVOL (\${i.coin})</div>
      <div style="font-size:22px;font-weight:800;color:\${d.dvolSignal==="high"?"#A32D2D":d.dvolSignal==="low"?"#3B6D11":"#1a1a1a"}">\${d.dvol?d.dvol.toFixed(1):"-"}</div>
      <div style="font-size:10px;font-weight:600;color:\${d.dvolSignal==="high"?"#A32D2D":d.dvolSignal==="low"?"#3B6D11":"#888"}">\${d.dvolSignal==="high"?"IV 과열→버퍼 확대":d.dvolSignal==="low"?"IV 낮음":"IV 보통"}</div></div>
  </div>\`}));
  // ATR bars
  const maxR=Math.max(...(d.ranges||[]).map(r=>r.range),1);
  const rc=e("div",{cls:"card"});rc.appendChild(e("div",{cls:"ct"},"가중 ATR 변동폭"));
  (d.ranges||[]).forEach(r=>{
    const bw=Math.round((r.range/maxR)*100),op=r.weight>=3?"1":r.weight>=2?".6":".3";
    const wl=r.weight>=3?"×3":r.weight>=2?"×2":"×1",wc=r.weight>=3?i.ac:r.weight>=2?"#888":"#ccc";
    rc.appendChild(e("div",{cls:"rr",html:\`<span style="min-width:36px">\${r.date}</span><span style="min-width:16px;font-size:9px;font-weight:700;color:\${wc}">\${wl}</span><div class="ro"><div class="ri" style="width:\${bw}%;background:\${i.ac};opacity:\${op}"></div></div><span style="min-width:58px;text-align:right">\$\${fmt(r.range)}</span>\`}));
  });
  w.appendChild(rc);
  // Products
  const pc=e("div",{cls:"card"});
  pc.appendChild(e("div",{cls:"ct"},"실제 DCD 상품 ("+d.products?.length+"개)"));
  if(!d.products?.length){pc.appendChild(e("div",{html:'<div style="font-size:12px;color:#aaa;text-align:center;padding:10px 0">상품 없음</div>'}));}
  else{
    pc.appendChild(e("div",{cls:"pg-h",style:"font-size:9px;color:#bbb;font-weight:700;text-transform:uppercase;margin-bottom:5px;padding:0 7px",html:"<span>행사가</span><span>만기</span><span style='text-align:right'>APY</span><span style='text-align:right'>안전</span>"}));
    d.products.slice(0,10).forEach(p=>{
      const isSafe=i.optType==="C"?p.strikeNum>=d.safeStrike:p.strikeNum<=d.safeStrike;
      const isRec=d.recommendation&&p.productId===d.recommendation.productId;
      pc.appendChild(e("div",{cls:"pr pg-h"+(isRec?" "+(i.key==="BTC-C"?"":i.key==="ETH-C"?"":""),isRec?'style="background:'+i.li+'"':""),
        html:\`<span style="font-family:monospace;font-weight:\${isRec?700:400};color:\${isRec?i.ac:"#1a1a1a"};font-size:11px">\${isRec?"★ ":""}\${Math.round(p.strikeNum).toLocaleString()}</span>
          <span style="color:#666;font-size:11px">\${p.expDate} <span style="color:#bbb;font-size:9px">(\${Math.ceil(p.daysLeft)}일)</span></span>
          <span style="text-align:right;font-family:monospace;font-weight:600;font-size:11px">\${(p.apy*100).toFixed(1)}%</span>
          <span style="text-align:right"><span style="font-size:10px;padding:1px 4px;border-radius:4px;background:\${isSafe?"#EAF3DE":"#FCEBEB"};color:\${isSafe?"#3B6D11":"#A32D2D"};font-weight:700">\${isSafe?"✓":"✗"}</span></span>\`}));
    });
    if(d.products.length>10)pc.appendChild(e("div",{style:"font-size:10px;color:#bbb;text-align:right;margin-top:3px"},\`외 \${d.products.length-10}개\`));
  }
  w.appendChild(pc);
  // Recommendation
  const rec=d.recommendation,score=d.riskScore||0,bc=score>=70?"#639922":score>=50?"#EF9F27":"#E24B4A",sl=SAF[SL(score)];
  if(rec){
    const recc=e("div",{cls:"card",style:"border:1.5px solid "+i.ac});
    if(d.adjusted)recc.appendChild(e("div",{cls:"adj"},"⚠ 리스크 미달 → 자동 상향 ("+d.iterations+"회)"));
    recc.innerHTML+=\`<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
      <div><div style="font-size:10px;color:#aaa;margin-bottom:2px">★ 추천 행사가</div><div style="font-size:24px;font-weight:800;font-family:monospace;color:\${i.ac}">\$\${fmt(rec.strikeNum)}</div></div>
      <div style="text-align:right"><div style="font-size:10px;color:#aaa;margin-bottom:2px">연환산 수익률</div><div style="font-size:20px;font-weight:700;font-family:monospace">\${fmtP(rec.apy)}</div></div>
    </div>\`;
    [["상품 ID",rec.productId,10],["만기",rec.expDate+" ("+Math.ceil(rec.daysLeft)+"일 후)",12],
     ["OTM 거리",i.optType==="C"?"+"+(((rec.strikeNum-d.price)/d.price)*100).toFixed(2)+"%":"-"+(((d.price-rec.strikeNum)/d.price)*100).toFixed(2)+"%",12],
     ["최소 투자",rec.minSize+" "+(i.optType==="C"?i.coin:i.quoteCcy),12]
    ].forEach(([l,v,fs])=>recc.innerHTML+=\`<div class="recrow"><span style="color:#888">\${l}</span><span style="font-family:monospace;font-weight:600;font-size:\${fs}px">\${v}</span></div>\`);
    recc.innerHTML+=\`<div class="recrow"><span style="color:#888">리스크 점수</span><span style="font-family:monospace;font-weight:700;color:\${bc}">\${score}/100</span></div>
      <div class="recrow"><span style="color:#888">안전 등급</span><span class="bdg" style="background:\${sl.bg};color:\${sl.c}">\${sl.l}</span></div>
      <div class="rrb"><div style="width:\${score}%;height:100%;border-radius:3px;background:\${bc}"></div></div>
      <div class="rbl"><span>위험</span><span>보통</span><span>안전</span></div>\`;
    recc.appendChild(e("button",{cls:"sb",style:"margin-top:10px",onClick:()=>{
      S.hf={date:new Date().toLocaleDateString("ko-KR"),coin:i.coin,strike:String(rec.strikeNum),apy:String((rec.apy*100).toFixed(2)),note:"",outcome:"pending"};
      S.page="history";render();
    }},"+ 이력에 저장"));
    w.appendChild(recc);
  }
  if(!d.hasSafe&&rec)w.appendChild(e("div",{cls:"ns"},"⚠ 안전 기준 상품 없음. APY 최고 상품 대체."));
  w.appendChild(e("div",{cls:"disc"},"※ OKX 공개 API 실시간 데이터. 실제 구독 전 OKX 앱 확인. 원금 손실 위험."));
  return w;
}

function renderSimulator(){
  const i=inst(),d=S.data,w=e("div",{style:"padding-top:14px"});
  if(!d){w.innerHTML='<div class="em"><div style="font-size:36px;margin-bottom:8px">⟿</div><div style="font-weight:700;color:#444;margin-bottom:4px">분석 먼저 실행하세요</div></div>';return w;}
  const prods=d.products||[],sp=prods[S.sIdx]||d.recommendation;
  const np=d.price*(1+S.sm/100),asgn=sp?(i.optType==="C"?np>=sp.strikeNum:np<=sp.strikeNum):false;
  const prem=sp?(sp.absYield||0)*S.si*d.price:0,opC=asgn&&sp?Math.abs(np-sp.strikeNum)*S.si:0,net=prem-opC;
  // Strike select
  const c1=e("div",{cls:"card"});c1.appendChild(e("div",{cls:"ct"},"행사가 선택"));
  const sel=e("select",{cls:"fi",style:"margin-bottom:8px",onChange:ev=>{S.sIdx=Number(ev.target.value);render();}});
  prods.slice(0,10).forEach((p,idx)=>{const o=e("option",{value:idx},"$"+fmt(p.strikeNum)+" — APY "+(p.apy*100).toFixed(1)+"% — "+p.expDate);if(idx===S.sIdx)o.setAttribute("selected","");sel.appendChild(o);});
  c1.appendChild(sel);c1.innerHTML+='<div style="font-size:11px;color:#888">현재가 <b style="color:'+i.ac+'">$'+fmt(d.price)+'</b></div>';w.appendChild(c1);
  // Invest
  const c2=e("div",{cls:"card"});c2.appendChild(e("div",{cls:"ct"},"투자 수량 ("+(i.optType==="C"?i.coin:i.quoteCcy)+")"));
  c2.appendChild(e("input",{type:"number",style:"width:100%;font-size:14px;padding:7px 9px;border-radius:7px;border:1px solid #ddd;font-family:monospace",value:String(S.si),min:"0.001",step:"0.1",onInput:ev=>{S.si=parseFloat(ev.target.value)||1;render();}}));
  w.appendChild(c2);
  // Slider
  const c3=e("div",{cls:"card"});
  c3.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div class="ct" style="margin:0">가격 변동</div><div style="font-family:monospace;font-size:14px;font-weight:700;color:'+(S.sm>=0?"#3B6D11":"#A32D2D")+'">'+(S.sm>=0?"+":"")+S.sm+'%</div></div>';
  c3.appendChild(e("input",{type:"range",style:"width:100%;margin:6px 0",min:"-30",max:"30",step:"1",value:String(S.sm),onInput:ev=>{S.sm=Number(ev.target.value);render();}}));
  c3.innerHTML+='<div style="display:flex;justify-content:space-between;font-size:10px;color:#bbb"><span>-30%</span><span>0</span><span>+30%</span></div>';
  w.appendChild(c3);
  if(sp){
    const rc=e("div",{cls:"sres",style:"border-color:"+(asgn?"#A32D2D":"#3B6D11")});
    rc.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><div style="font-size:15px;font-weight:700">시나리오 결과</div><span class="bdg" style="background:'+(asgn?"#FCEBEB":"#EAF3DE")+';color:'+(asgn?"#A32D2D":"#3B6D11")+'">'+(asgn?"⚠ 할당됨":"✅ 미할당")+'</span></div>';
    [["만기 예상가","$"+fmt(np),np>=d.price?"#3B6D11":"#A32D2D"],
     ["행사가","$"+fmt(sp.strikeNum),i.ac],
     ["프리미엄","+$"+prem.toFixed(4),"#3B6D11"],
     ...(asgn?[["기회비용","-$"+opC.toFixed(4),"#A32D2D"]]:[]),
     ["순 손익",(net>=0?"+":"")+net.toFixed(4)+" "+i.quoteCcy,net>=0?"#3B6D11":"#A32D2D"],
    ].forEach(([l,v,c],idx,arr)=>{
      rc.innerHTML+='<div class="recrow"'+(idx===arr.length-1?' style="border-bottom:none"':'')+'><span style="color:#888">'+l+'</span><span style="font-family:monospace;font-weight:700;color:'+c+'">'+v+'</span></div>';
    });
    w.appendChild(rc);
  }
  return w;
}

function renderHistory(){
  const i=inst(),w=e("div",{style:"padding-top:14px"});
  const comp=S.hist.filter(h=>h.outcome!=="pending"),asgn=S.hist.filter(h=>h.outcome==="assigned");
  const rate=comp.length?Math.round(asgn.length/comp.length*100):null;
  const avg=S.hist.length?S.hist.reduce((s,h)=>s+(parseFloat(h.apy)||0),0)/S.hist.length:null;
  if(S.hist.length){
    const sg=e("div",{cls:"hs"});
    [{l:"총 기록",v:S.hist.length+"회"},{l:"할당률",v:rate!=null?rate+"%":"-"},{l:"평균 APY",v:avg!=null?avg.toFixed(1)+"%":"-"}].forEach(m=>{
      sg.innerHTML+='<div class="hsi"><div style="font-size:9px;color:#999;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px">'+m.l+'</div><div style="font-size:16px;font-weight:700;font-family:monospace">'+m.v+'</div></div>';
    });
    w.appendChild(sg);
  }
  const fc=e("div",{cls:"card"});fc.appendChild(e("div",{cls:"ct"},"기록 추가"));
  const fg2=e("div",{cls:"fg"});
  [["날짜","text","4/15","date"],["행사가($)","number","75000","strike"],["APY(%)","number","11.2","apy"]].forEach(([l,t,ph,k])=>{
    const d2=e("div",{});d2.innerHTML='<div class="fl">'+l+'</div>';
    d2.appendChild(e("input",{type:t,cls:"fi",placeholder:ph,value:S.hf[k]||"",onInput:ev=>S.hf[k]=ev.target.value}));
    fg2.appendChild(d2);
  });
  const cd=e("div",{});cd.innerHTML='<div class="fl">코인</div>';
  const cs=e("select",{cls:"fi",onChange:ev=>S.hf.coin=ev.target.value});
  ["BTC","ETH"].forEach(c=>{const o=e("option",{value:c},c);if(c===S.hf.coin)o.setAttribute("selected","");cs.appendChild(o);});
  cd.appendChild(cs);fg2.appendChild(cd);fc.appendChild(fg2);
  fc.appendChild(e("input",{type:"text",cls:"fi",style:"width:100%;margin-bottom:7px",placeholder:"메모 (선택)",value:S.hf.note||"",onInput:ev=>S.hf.note=ev.target.value}));
  fc.appendChild(e("button",{cls:"sb",onClick:addHist},"+ 저장"));
  w.appendChild(fc);
  if(!S.hist.length){w.appendChild(e("div",{style:"text-align:center;padding:32px 0;color:#aaa;font-size:13px"},"기록 없음"));}
  else S.hist.forEach(h=>{
    const hc=e("div",{cls:"hi"});
    hc.innerHTML='<div class="hih"><div><span style="font-family:monospace;font-weight:700;font-size:14px">$'+Number(h.strike).toLocaleString()+'</span><span style="font-size:11px;color:#888;margin-left:8px">'+h.coin+' · '+h.apy+'% APY</span></div><span class="bdg" style="background:'+(h.outcome==="assigned"?"#FCEBEB":h.outcome==="pending"?"#FAEEDA":"#EAF3DE")+';color:'+(h.outcome==="assigned"?"#A32D2D":h.outcome==="pending"?"#854F0B":"#3B6D11")+'">'+(h.outcome==="assigned"?"할당":h.outcome==="pending"?"진행중":"미할당")+'</span></div><div style="font-size:11px;color:#aaa">'+h.createdAt+(h.note?" · "+h.note:"")+'</div>';
    if(h.outcome==="pending"){
      const ha=e("div",{cls:"ha"});
      ha.appendChild(e("button",{cls:"hb",style:"border-color:#E24B4A;background:#FCEBEB;color:#A32D2D",onClick:()=>updOut(h.id,"assigned")},"할당됨"));
      ha.appendChild(e("button",{cls:"hb",style:"border-color:#639922;background:#EAF3DE;color:#3B6D11",onClick:()=>updOut(h.id,"not_assigned")},"미할당"));
      ha.appendChild(e("button",{cls:"hb",style:"color:#aaa",onClick:()=>delHist(h.id)},"삭제"));
      hc.appendChild(ha);
    }
    w.appendChild(hc);
  });
  return w;
}

function renderPortfolio(){
  const i=inst(),w=e("div",{style:"padding-top:14px"});
  const pend=S.hist.filter(h=>h.outcome==="pending"),comp=S.hist.filter(h=>h.outcome!=="pending"),asgn=S.hist.filter(h=>h.outcome==="assigned");
  const rate=comp.length?Math.round(asgn.length/comp.length*100):null;
  const avg=S.hist.length?S.hist.reduce((s,h)=>s+(parseFloat(h.apy)||0),0)/S.hist.length:null;
  const hc=e("div",{cls:"card"});
  const hh=e("div",{style:"display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"});
  hh.innerHTML='<div class="ct" style="margin:0">보유 현황</div>';
  hh.appendChild(e("button",{cls:"eb2",onClick:()=>{S.pfe=!S.pfe;S.pfv={btc:String(S.pf.btc),eth:String(S.pf.eth),usdg:String(S.pf.usdg)};render();}},S.pfe?"취소":"수정"));
  hc.appendChild(hh);
  if(S.pfe){
    [["BTC","btc"],["ETH","eth"],["USDG","usdg"]].forEach(([l,k])=>{
      const r=e("div",{cls:"per"});r.innerHTML='<span style="min-width:44px;font-size:12px;font-weight:700">'+l+'</span>';
      r.appendChild(e("input",{type:"number",cls:"pi",value:S.pfv[k],min:"0",step:"0.01",onInput:ev=>S.pfv[k]=ev.target.value}));
      hc.appendChild(r);
    });
    hc.appendChild(e("button",{cls:"sb",style:"margin-top:4px",onClick:savePf},"저장"));
  } else {
    const pg=e("div",{cls:"pfg"});
    [["BTC","#BA7517",S.pf.btc],["ETH","#185FA5",S.pf.eth],["USDG","#3B6D11",S.pf.usdg]].forEach(([l,c,v])=>{
      pg.innerHTML+='<div class="pfc"><div style="font-size:10px;color:#999;margin-bottom:3px">'+l+'</div><div style="font-size:16px;font-weight:700;font-family:monospace;color:'+c+'">'+v+'</div></div>';
    });
    hc.appendChild(pg);
  }
  w.appendChild(hc);
  const pc=e("div",{cls:"card"});pc.appendChild(e("div",{cls:"ct"},"진행 중 ("+pend.length+"개)"));
  if(!pend.length)pc.innerHTML+='<div style="font-size:12px;color:#aaa;text-align:center;padding:10px 0">없음</div>';
  else pend.forEach(p=>pc.innerHTML+='<div class="ppr"><span style="font-family:monospace;font-weight:600">'+p.coin+' $'+Number(p.strike).toLocaleString()+'</span><span style="color:#888">'+p.apy+'% APY</span></div>');
  w.appendChild(pc);
  if(S.hist.length){
    const sc=e("div",{cls:"card"});sc.appendChild(e("div",{cls:"ct"},"운용 통계"));
    [["총 기록",S.hist.length+"회"],["할당률",rate!=null?rate+"%":"-"],["평균 APY",avg!=null?avg.toFixed(2)+"%":"-"],["미할당 수익",S.hist.filter(h=>h.outcome==="not_assigned").length+"회"]].forEach(([l,v],idx,arr)=>{
      sc.innerHTML+='<div class="sr"'+(idx===arr.length-1?' style="border-bottom:none"':'')+'>><span style="color:#888">'+l+'</span><span style="font-family:monospace;font-weight:600">'+v+'</span></div>';
    });
    w.appendChild(sc);
  }
  w.appendChild(e("div",{cls:"disc"},"※ 이력·포트폴리오는 브라우저 localStorage에 저장됩니다."));
  return w;
}

function render(){
  const i=inst(),app=document.getElementById("app");
  app.innerHTML="";cv(app,i.ac,i.li);
  const hd=e("div",{cls:"hd"});cv(hd,i.ac,i.li);
  // Tabs
  const tabs=e("div",{cls:"tabs"});
  INSTS.forEach(it=>{
    const t=e("div",{cls:"tab"+(it.key===S.sk?" on":""),onClick:()=>{S.sk=it.key;S.phase="idle";S.data=null;S.err="";render();}});
    cv(t,it.ac,it.li);
    t.innerHTML='<div class="tl">'+it.label+'</div><div class="tt" style="background:'+it.tBg+';color:'+it.tC+'">'+it.tag+'</div>';
    tabs.appendChild(t);
  });
  hd.appendChild(tabs);
  // Nav
  const nav=e("div",{cls:"nav"});cv(nav,i.ac,i.li);
  PAGES.forEach(p=>{
    const b=e("button",{cls:"nb"+(p.key===S.page?" on":""),onClick:()=>{S.page=p.key;render();}});
    b.innerHTML='<span>'+p.icon+'</span><span>'+p.lbl+'</span>';
    nav.appendChild(b);
  });
  hd.appendChild(nav);
  // Controls
  if(S.page==="analysis"){
    const ctrl=e("div",{cls:"ctrl"});
    const sel=e("select",{onChange:ev=>S.exp=Number(ev.target.value)});
    [{v:3,l:"만기 1~3일"},{v:5,l:"만기 1~5일"},{v:7,l:"만기 1~7일"}].forEach(o=>{
      const opt=e("option",{value:o.v},o.l);if(o.v===S.exp)opt.setAttribute("selected","");sel.appendChild(opt);
    });
    const btn=e("button",{cls:"rb",onClick:runAnalysis},S.phase==="loading"?"조회 중...":"▶ 실시간 분석");
    if(S.phase==="loading")btn.setAttribute("disabled","");
    ctrl.append(sel,btn);hd.appendChild(ctrl);
  }
  app.appendChild(hd);
  const pg=e("div",{cls:"pg"});cv(pg,i.ac,i.li);
  if(S.page==="analysis")  pg.appendChild(renderAnalysis());
  if(S.page==="simulator") pg.appendChild(renderSimulator());
  if(S.page==="history")   pg.appendChild(renderHistory());
  if(S.page==="portfolio") pg.appendChild(renderPortfolio());
  app.appendChild(pg);
}
init();
<\/script></body></html>`);
});

app.listen(PORT, () => console.log(`🚀 DCD v2 on port ${PORT}`));
