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

// ── Fetchers ──────────────────────────────────────────────────────────────────
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

// ── Analysis helpers ──────────────────────────────────────────────────────────
const weightedATR = (candles) => {
  // 최근 3일에 높은 가중치 (최신: 3, 2, 2, 이후: 1)
  const weights = [3, 2, 2, 1, 1, 1, 1];
  let wSum = 0, wTot = 0;
  candles.forEach((c, i) => {
    const range = parseFloat(c[2]) - parseFloat(c[3]);
    const w = weights[i] ?? 1;
    wSum += range * w;
    wTot += w;
  });
  return wSum / wTot;
};

const riskScore = (price, strike, wATR, fundingRate, optType) => {
  const dist = optType === "C" ? (strike - price) / price : (price - strike) / price;
  const distScore = Math.min(40, Math.max(0, dist * 500));
  const volScore  = Math.min(20, Math.max(0, (1 - (wATR / price) * 10) * 20));
  const frScore   = Math.min(20, Math.max(0, (1 - Math.abs(fundingRate) * 2000) * 20));
  return Math.round(distScore + volScore + frScore + 20);
};

const autoAdjust = (products, safeStrike, optType, price, wATR, fundingRate) => {
  const safe = products
    .filter(p => optType === "C" ? p.strikeNum >= safeStrike : p.strikeNum <= safeStrike)
    .sort((a, b) => optType === "C" ? a.strikeNum - b.strikeNum : b.strikeNum - a.strikeNum);

  if (!safe.length) return { product: products[0] ?? null, adjusted: false, iterations: 0 };

  for (let i = 0; i < Math.min(4, safe.length); i++) {
    const score = riskScore(price, safe[i].strikeNum, wATR, fundingRate, optType);
    if (score >= 60 || i === safe.length - 1) {
      return { product: safe[i], adjusted: i > 0, iterations: i, score };
    }
  }
  return { product: safe[0], adjusted: false, iterations: 0 };
};

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "OKX DCD Proxy v2" }));

// OKX generic proxy
app.get("/api/*", async (req, res) => {
  const path = req.path.replace("/api", "");
  const qs   = new URLSearchParams(req.query).toString();
  try {
    const data = await okx(`${path}${qs ? "?" + qs : ""}`);
    res.json({ code: "0", data });
  } catch (e) {
    res.status(500).json({ code: "500", msg: e.message });
  }
});

// Combined analysis endpoint
app.get("/data", async (req, res) => {
  const { coin = "BTC", optType = "C", quoteCcy = "USDG", expiryDays = "3" } = req.query;
  const days   = parseInt(expiryDays);
  const spotId = `${coin}-USDT`;
  const swapId = `${coin}-USDT-SWAP`;

  try {
    const [tickerData, candleData, fundingData, dcdData, fg, dvolVal] = await Promise.all([
      okx(`/market/ticker?instId=${spotId}`),
      okx(`/market/candles?instId=${spotId}&bar=1D&limit=9`),
      okx(`/public/funding-rate?instId=${swapId}`),
      okx(`/finance/sfp/dcd/products?baseCcy=${coin}&quoteCcy=${quoteCcy}&optType=${optType}`),
      fearGreed(),
      dvol(coin),
    ]);

    const price    = parseFloat(tickerData[0].last);
    const open24h  = parseFloat(tickerData[0].open24h);
    const change24h = ((price - open24h) / open24h) * 100;

    const candles = candleData.slice(1, 8);
    const weights = [3, 2, 2, 1, 1, 1, 1];
    const ranges  = candles.map((c, i) => ({
      date:   new Date(parseInt(c[0])).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      range:  parseFloat(c[2]) - parseFloat(c[3]),
      weight: weights[i] ?? 1,
    }));

    const simpleATR = ranges.reduce((s, r) => s + r.range, 0) / ranges.length;
    const wATR      = weightedATR(candles);
    const atr2x     = wATR * 2;

    const fundingRate   = parseFloat(fundingData[0].fundingRate);
    const fundingStatus = fundingRate > 0.0001 ? "hot" : fundingRate < 0 ? "negative" : "normal";

    const safeStrike = optType === "C"
      ? Math.max(price + atr2x, price * 1.05)
      : Math.min(price - atr2x, price * 0.95);

    const now      = Date.now();
    const products = (dcdData.products || [])
      .map(p => ({
        productId: p.productId,
        strikeNum: parseFloat(p.strike),
        apy:       parseFloat(p.annualizedYield),
        absYield:  parseFloat(p.absYield),
        daysLeft:  (parseInt(p.expTime) - now) / 86400000,
        expDate:   new Date(parseInt(p.expTime)).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }),
        expTime:   p.expTime,
        minSize:   p.minSize,
      }))
      .filter(p => p.daysLeft >= 0.5 && p.daysLeft <= days)
      .sort((a, b) => b.apy - a.apy);

    const { product: rec, adjusted, iterations } = autoAdjust(
      products, safeStrike, optType, price, wATR, fundingRate
    );

    const score = rec ? riskScore(price, rec.strikeNum, wATR, fundingRate, optType) : 0;

    const weekHigh = Math.max(...ranges.map(r => r.high));
    const weekLow  = Math.min(...ranges.map(r => r.low));
    const mid      = (weekHigh + weekLow) / 2;
    const trend    = price > mid * 1.01 ? "bullish" : price < mid * 0.99 ? "bearish" : "neutral";

    // DVOL signal: >70 = expand buffer, <40 = tighten
    const dvolSignal = dvolVal > 70 ? "high" : dvolVal < 40 ? "low" : "normal";

    res.json({
      price, change24h, weekHigh, weekLow, trend,
      simpleATR, wATR, atr2x, safeStrike,
      fundingRate, fundingStatus,
      fearGreed: fg,
      dvol: dvolVal, dvolSignal,
      ranges, products,
      recommendation: rec,
      riskScore: score,
      adjusted, iterations,
      hasSafe: products.some(p => optType === "C" ? p.strikeNum >= safeStrike : p.strikeNum <= safeStrike),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Telegram notification
const tgSend = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
  });
};

app.post("/telegram", async (req, res) => {
  if (!TG_TOKEN || !TG_CHAT) return res.status(400).json({ error: "Telegram not configured" });
  try {
    await tgSend(req.body.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Daily cron: 9am KST ───────────────────────────────────────────────────────
if (TG_TOKEN && TG_CHAT) {
  cron.schedule("0 0 * * *", async () => {
    try {
      const [btcR, ethR] = await Promise.all([
        fetch(`http://localhost:${PORT}/data?coin=BTC&optType=C&quoteCcy=USDG&expiryDays=3`).then(r => r.json()),
        fetch(`http://localhost:${PORT}/data?coin=ETH&optType=C&quoteCcy=USDG&expiryDays=3`).then(r => r.json()),
      ]);

      const fmt = (n) => n?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "-";
      const fmtPct = (n) => n != null ? (n * 100).toFixed(2) + "%" : "-";

      const msg = [
        "📊 <b>DCD 일일 분석 리포트</b>",
        "",
        `🟡 <b>BTC-USDG 콜</b>`,
        `• 현재가: $${fmt(btcR.price)}  (${btcR.change24h >= 0 ? "+" : ""}${btcR.change24h?.toFixed(2)}%)`,
        `• 추천 행사가: $${fmt(btcR.recommendation?.strikeNum)}`,
        `• APY: ${fmtPct(btcR.recommendation?.apy)}  리스크: ${btcR.riskScore}/100`,
        btcR.adjusted ? "• ⚠ 행사가 자동 상향 적용됨" : "",
        "",
        `🔵 <b>ETH-USDG 콜</b>`,
        `• 현재가: $${fmt(ethR.price)}  (${ethR.change24h >= 0 ? "+" : ""}${ethR.change24h?.toFixed(2)}%)`,
        `• 추천 행사가: $${fmt(ethR.recommendation?.strikeNum)}`,
        `• APY: ${fmtPct(ethR.recommendation?.apy)}  리스크: ${ethR.riskScore}/100`,
        ethR.adjusted ? "• ⚠ 행사가 자동 상향 적용됨" : "",
        "",
        `😨 공포탐욕: ${btcR.fearGreed?.value} (${btcR.fearGreed?.label})`,
        `📈 BTC DVOL: ${btcR.dvol?.toFixed(1) ?? "-"}`,
      ].filter(l => l !== undefined).join("\n");

      await tgSend(msg);
    } catch (e) {
      console.error("Cron error:", e.message);
    }
  }, { timezone: "Asia/Seoul" });

  console.log("✅ Telegram cron: daily 9am KST");
}

app.listen(PORT, () => console.log(`🚀 DCD Proxy v2 on port ${PORT}`));
