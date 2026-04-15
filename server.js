const express = require("express");
const cors    = require("cors");
const path    = require("path");
const cron    = require("node-cron");
const crypto  = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT     = process.env.PORT || 3000;
const OKX_BASE = "https://www.okx.com/api/v5";
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const OKX_KEY  = process.env.OKX_API_KEY;
const OKX_SEC  = process.env.OKX_SECRET_KEY;
const OKX_PASS = process.env.OKX_PASSPHRASE;

// ── OKX API 호출 ──────────────────────────────────────────────────────────────
const okxPub = async (p) => {
  const r = await fetch(OKX_BASE + p, { headers: { Accept: "application/json" } });
  const j = await r.json();
  if (j.code !== "0") throw new Error(j.msg || "OKX public error");
  return j.data;
};

const okxAuth = async (p) => {
  const ts  = new Date().toISOString();
  const msg = ts + "GET" + "/api/v5" + p;
  const sig = crypto.createHmac("sha256", OKX_SEC).update(msg).digest("base64");
  const r = await fetch(OKX_BASE + p, {
    headers: {
      "Content-Type":        "application/json",
      "OK-ACCESS-KEY":       OKX_KEY,
      "OK-ACCESS-SIGN":      sig,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": OKX_PASS,
    },
  });
  const j = await r.json();
  if (j.code !== "0") throw new Error("OKX " + j.code + ": " + (j.msg || "unknown"));
  return j.data;
};

// ── Analysis helpers ──────────────────────────────────────────────────────────
const fearGreed = async () => {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    const j = await r.json();
    return { value: parseInt(j.data[0].value), label: j.data[0].value_classification };
  } catch { return { value: 50, label: "Neutral" }; }
};

const dvol = async (coin) => {
  try {
    const r = await fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=" + coin.toLowerCase() + "dvol_usdc");
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

// ── Data endpoint ─────────────────────────────────────────────────────────────
app.get("/data", async (req, res) => {
  const { coin = "BTC", optType = "C", quoteCcy = "USDG", expiryDays = "3" } = req.query;
  const days = parseInt(expiryDays);
  try {
    // 공개 API (인증 불필요)
    const [tickerData, candleData, fundingData, fg, dvolVal] = await Promise.all([
      okxPub("/market/ticker?instId=" + coin + "-USDT"),
      okxPub("/market/candles?instId=" + coin + "-USDT&bar=1D&limit=9"),
      okxPub("/public/funding-rate?instId=" + coin + "-USDT-SWAP"),
      fearGreed(),
      dvol(coin),
    ]);

    // 인증 필요 API (DCD 상품)
    const dcdData = await okxAuth(
      "/finance/sfp/dcd/products?baseCcy=" + coin + "&quoteCcy=" + quoteCcy + "&optType=" + optType
    );

    const price     = parseFloat(tickerData[0].last);
    const change24h = ((price - parseFloat(tickerData[0].open24h)) / parseFloat(tickerData[0].open24h)) * 100;
    const candles   = candleData.slice(1, 8);
    const weights   = [3, 2, 2, 1, 1, 1, 1];
    const ranges    = candles.map((c, i) => ({
      date:   new Date(parseInt(c[0])).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      high:   parseFloat(c[2]), low: parseFloat(c[3]),
      range:  parseFloat(c[2]) - parseFloat(c[3]),
      weight: weights[i] ?? 1,
    }));
    const simpleATR   = ranges.reduce((s, r) => s + r.range, 0) / ranges.length;
    const wATR        = weightedATR(candles);
    const atr2x       = wATR * 2;
    const fundingRate = parseFloat(fundingData[0].fundingRate);
    const fundingStatus = fundingRate > 0.0001 ? "hot" : fundingRate < 0 ? "negative" : "normal";
    const safeStrike  = optType === "C"
      ? Math.max(price + atr2x, price * 1.05)
      : Math.min(price - atr2x, price * 0.95);
    const now = Date.now();
    const products = (dcdData.products || [])
      .map(p => ({
        productId: p.productId,
        strikeNum: parseFloat(p.strike),
        apy:       parseFloat(p.annualizedYield),
        absYield:  parseFloat(p.absYield),
        daysLeft:  (parseInt(p.expTime) - now) / 86400000,
        expDate:   new Date(parseInt(p.expTime)).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
        minSize:   p.minSize,
      }))
      .filter(p => p.daysLeft >= 0.5 && p.daysLeft <= days)
      .sort((a, b) => b.apy - a.apy);
    const { product: rec, adjusted, iterations } = autoAdjust(products, safeStrike, optType, price, wATR, fundingRate);
    const score    = rec ? riskScore(price, rec.strikeNum, wATR, fundingRate, optType) : 0;
    const weekHigh = Math.max(...ranges.map(r => r.high));
    const weekLow  = Math.min(...ranges.map(r => r.low));
    const mid      = (weekHigh + weekLow) / 2;
    res.json({
      price, change24h, weekHigh, weekLow,
      trend: price > mid * 1.01 ? "bullish" : price < mid * 0.99 ? "bearish" : "neutral",
      simpleATR, wATR, atr2x, safeStrike, fundingRate, fundingStatus,
      fearGreed: fg, dvol: dvolVal,
      dvolSignal: dvolVal > 70 ? "high" : dvolVal < 40 ? "low" : "normal",
      ranges, products, recommendation: rec,
      riskScore: score, adjusted, iterations,
      hasSafe: products.some(p => optType === "C" ? p.strikeNum >= safeStrike : p.strikeNum <= safeStrike),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Telegram ──────────────────────────────────────────────────────────────────
const tgSend = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
  });
};

if (TG_TOKEN && TG_CHAT) {
  cron.schedule("0 0 * * *", async () => {
    try {
      const [b, e2] = await Promise.all([
        fetch("http://localhost:" + PORT + "/data?coin=BTC&optType=C&quoteCcy=USDG&expiryDays=3").then(r => r.json()),
        fetch("http://localhost:" + PORT + "/data?coin=ETH&optType=C&quoteCcy=USDG&expiryDays=3").then(r => r.json()),
      ]);
      const f = n => n?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "-";
      const p = n => n != null ? (n * 100).toFixed(2) + "%" : "-";
      await tgSend([
        "📊 <b>DCD 일일 분석 리포트</b>", "",
        "🟡 <b>BTC-USDG 콜</b>",
        "• 현재가: $" + f(b.price) + " (" + (b.change24h >= 0 ? "+" : "") + b.change24h?.toFixed(2) + "%)",
        "• 추천: $" + f(b.recommendation?.strikeNum) + " / APY: " + p(b.recommendation?.apy) + " / 리스크: " + b.riskScore + "/100",
        b.adjusted ? "• ⚠ 자동 상향 적용" : "", "",
        "🔵 <b>ETH-USDG 콜</b>",
        "• 현재가: $" + f(e2.price) + " (" + (e2.change24h >= 0 ? "+" : "") + e2.change24h?.toFixed(2) + "%)",
        "• 추천: $" + f(e2.recommendation?.strikeNum) + " / APY: " + p(e2.recommendation?.apy) + " / 리스크: " + e2.riskScore + "/100",
        e2.adjusted ? "• ⚠ 자동 상향 적용" : "", "",
        "😨 공포탐욕: " + b.fearGreed?.value + " (" + b.fearGreed?.label + ")",
        "📈 BTC DVOL: " + (b.dvol?.toFixed(1) ?? "-"),
      ].join("\n"));
    } catch (e) { console.error("Cron:", e.message); }
  }, { timezone: "Asia/Seoul" });
  console.log("✅ Telegram cron: daily 9am KST");
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log("🚀 DCD v2 on port " + PORT));
