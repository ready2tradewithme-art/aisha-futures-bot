/**
 * Aisha World-Class Institutional Futures Auto-Trader Daemon v19.0 Enterprise
 * Deployed 24x7 on Render.com Cloud (Zero PC Needed)
 */

import crypto from 'crypto';

const KEY = process.env.COINDCX_KEY || "c489dbbdc334517181b1770971d5351d9c5fb320ed5c6c36";
const SECRET = process.env.COINDCX_SECRET || "c71146d4d1c1688d8989ca58295300154e8688d79ed2b22561386a31225bbcaa";
const WORKER_URL = "https://aisha-guardian-futures-v7.amit-aisha.workers.dev";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8704603092:AAHccB_w0p4l9uus2oVLH2uOBNsBuJx4EoU";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "-1004420260047";

function getTimestamp() {
  const d = new Date();
  return d.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

let activePositionState = null;
const executedOrderIds = new Set();

async function sendTelegramAlert(messageHtml) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: messageHtml,
        parse_mode: 'HTML'
      })
    });
  } catch {}
}

async function fetchLiveCoinDCXTickers() {
  let btcUsdtLtp = 63218.1;
  let usdtInrRate = 90.0;
  let isStale = false;

  try {
    const res = await fetch('https://api.coindcx.com/exchange/ticker');
    if (res.status === 200) {
      const tickers = await res.json();
      if (Array.isArray(tickers)) {
        const btcMatch = tickers.find(t => t.market === 'BTCUSDT' || t.market === 'B-BTC_USDT');
        if (btcMatch && btcMatch.last_price) btcUsdtLtp = parseFloat(btcMatch.last_price);

        const usdtMatch = tickers.find(t => t.market === 'USDTINR');
        if (usdtMatch && usdtMatch.last_price) usdtInrRate = parseFloat(usdtMatch.last_price);
      }
    } else {
      isStale = true;
    }
  } catch {
    isStale = true;
  }

  return { btcUsdtLtp, usdtInrRate, isStale };
}

async function executeLiveFuturesOrder(symbol, side, price, quantityUsdt, leverage, confidencePct) {
  const clientOrderId = `AISHA_${symbol}_${side}_${Math.floor(Date.now() / 1000)}`;
  if (executedOrderIds.has(clientOrderId)) {
    return { success: false, reason: 'Duplicate order prevented' };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const pair = `B-${symbol.toUpperCase()}_USDT`;
  let qty = parseFloat((quantityUsdt / price).toFixed(3));

  if (qty <= 0) return { success: false, reason: 'Invalid quantity' };

  // 2-Tier Sizing: 80% for confirmed >=94%, 60% max for normal
  const marginCurrencies = ["USDT", "INR"];
  const marginScale = confidencePct >= 94 ? 0.80 : 0.60;
  const scaledQty = parseFloat((qty * marginScale).toFixed(3));

  for (const marginCurrency of marginCurrencies) {
    const orderPayload = {
      timestamp,
      order: {
        side: side.toLowerCase(),
        pair,
        order_type: "market_order",
        total_quantity: scaledQty,
        leverage: parseInt(leverage) || 3,
        margin_currency: marginCurrency,
        client_order_id: `${clientOrderId}_${marginCurrency}`
      }
    };

    const payloadString = JSON.stringify(orderPayload);
    const signature = crypto.createHmac('sha256', SECRET).update(payloadString).digest('hex');

    console.log(`[${getTimestamp()}] 🚀 EXECUTION ATTEMPT: ${side.toUpperCase()} ${pair} @ $${price} (${leverage}x) | Margin: ${marginCurrency} | Qty: ${scaledQty}`);

    try {
      const res = await fetch('https://api.coindcx.com/exchange/v1/orders/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AUTH-APIKEY': KEY,
          'X-AUTH-SIGNATURE': signature
        },
        body: payloadString
      });

      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text); } catch {}

      if (res.status === 200 || data.id || data.status === 'success') {
        executedOrderIds.add(clientOrderId);

        const alertMsg = `🚀 <b>RENDER 24x7 CLOUD AUTO-ORDER EXECUTED ON COINDCX!</b>\n\n` +
          `<b>Asset:</b> ${symbol} FUTURES (${leverage}x)\n` +
          `<b>Side:</b> ${side.toUpperCase()} 🟢\n` +
          `<b>Execution Price:</b> $${price}\n` +
          `<b>Quantity:</b> ${scaledQty} ${symbol}\n` +
          `<b>Margin Currency:</b> ${marginCurrency}\n` +
          `<b>Order ID:</b> <code>${data.id || clientOrderId}</code>\n` +
          `<b>Server:</b> Render 24x7 Cloud Daemon 🟢`;

        await sendTelegramAlert(alertMsg);
        console.log(`[${getTimestamp()}] ✅ Order Filled! ID: ${data.id || clientOrderId}`);
        return { success: true, orderId: data.id || clientOrderId };
      } else {
        console.log(`[${getTimestamp()}] ℹ️ Attempt (${marginCurrency}): ${text.slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`[${getTimestamp()}] Network error: ${e.message}`);
    }
  }

  return { success: false, reason: 'Executed all margin attempts' };
}

async function runDaemonLoop() {
  console.log(`[${getTimestamp()}] 🤖 Aisha Render 24x7 Cloud Daemon Scanning...`);
  try {
    const res = await fetch(`${WORKER_URL}/api/scan`, { method: 'POST' });
    const data = await res.json();

    if (data.signals && data.signals.length > 0) {
      for (const sig of data.signals) {
        if (sig.confidence >= 85) {
          const p = sig.tradePlan || {};
          const lev = p.leverage || 5;
          const entry = sig.currentPrice || p.entryPrice;
          await executeLiveFuturesOrder(sig.symbol, sig.decision, entry, p.positionSizeUsdt || 50, lev, sig.confidence);
        }
      }
    }
  } catch (e) {
    console.log(`[${getTimestamp()}] Loop Tick Error: ${e.message}`);
  }
}

console.log("=====================================================================================");
console.log("🤖 AISHA WORLD-CLASS FUTURES DAEMON - RENDER.COM 24x7 CLOUD ENGINE ACTIVE");
console.log("👤 Account: Amit gupta (amit26992@gmail.com)");
console.log("=====================================================================================");

setInterval(runDaemonLoop, 5000);
runDaemonLoop();
