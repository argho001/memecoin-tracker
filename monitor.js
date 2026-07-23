/**
 * Wallet Monitor — GMGN Edition with Rate Limiter
 *
 * GMGN rate limit: leaky bucket, capacity=20, rate=20/sec
 * wallet_activity weight=3 → max 6 calls per burst, then wait for refill
 */

const EventEmitter = require('events');
const db = require('./db');
const { GmgnClient } = require('./gmgn');

const events = new EventEmitter();

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 3000;
const GMGN_API_KEYS = process.env.GMGN_API_KEYS || process.env.GMGN_API_KEY || '';
const gmgnKeys = GMGN_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);

const gmgn = new GmgnClient(gmgnKeys);

// Track last seen activity per wallet
const lastSeenTx = new Map();

// ── Rate Limiter ──────────────────────────────────────────────
// GMGN: capacity=20, rate=20 tokens/sec, wallet_activity weight=3
const bucket = { tokens: 20, lastRefill: Date.now(), capacity: 20, rate: 20 };

async function waitForToken(weight = 3) {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.rate);
  bucket.lastRefill = now;

  if (bucket.tokens >= weight) {
    bucket.tokens -= weight;
    return;
  }
  // Wait for enough tokens to refill
  const waitMs = ((weight - bucket.tokens) / bucket.rate) * 1000 + 50;
  await new Promise(r => setTimeout(r, waitMs));
  bucket.tokens = 0;
}

// ── Fetch ─────────────────────────────────────────────────────
async function fetchWalletActivity(walletAddress, limit = 20) {
  if (gmgnKeys.length === 0) throw new Error('GMGN_API_KEY not set');
  return gmgn.getWalletActivity(walletAddress, { limit });
}

// ── Parse ─────────────────────────────────────────────────────
function parseActivity(activity, walletAddress) {
  const type = activity.event_type;
  if (!type || !['buy', 'sell'].includes(type)) return null;

  const tokenAddress = activity.token?.address;
  if (!tokenAddress) return null;

  const amountSol = parseFloat(activity.quote_amount) || 0;
  const amountTokens = parseFloat(activity.token_amount) || 0;
  const priceSol = parseFloat(activity.price) || 0;

  return {
    signature: activity.tx_hash || '',
    timestamp: activity.timestamp
      ? new Date(activity.timestamp * 1000).toISOString()
      : new Date().toISOString(),
    type: type.toUpperCase(),
    tokenAddress,
    tokenSymbol: activity.token?.symbol || 'UNKNOWN',
    tokenName: activity.token?.name || '',
    amountSol,
    amountTokens,
    priceSol,
    dex: activity.launchpad_platform || activity.launchpad || 'unknown',
    rawData: activity,
  };
}

// ── SOL Price ─────────────────────────────────────────────────
let solPriceCache = { price: 0, ts: 0 };
async function getSolPriceUsd() {
  if (solPriceCache.price > 0 && Date.now() - solPriceCache.ts < 60000) {
    return solPriceCache.price;
  }
  try {
    const axios = require('axios');
    const { data } = await axios.get(
      'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
      { timeout: 5000 }
    );
    const price = data?.data?.['So11111111111111111111111111111111111111112']?.price || 0;
    if (price > 0) solPriceCache = { price, ts: Date.now() };
    return price;
  } catch (e) {
    return 0;
  }
}

async function enrichWithSolPrice(trade) {
  if (trade.amountSol > 0 && trade.amountTokens > 0 && trade.priceSol <= 0) {
    trade.priceSol = trade.amountSol / trade.amountTokens;
  }
  if (trade.amountSol <= 0 && trade.rawData?.cost_usd) {
    const solPrice = await getSolPriceUsd();
    if (solPrice > 0) {
      trade.amountSol = trade.rawData.cost_usd / solPrice;
      if (trade.amountTokens > 0) trade.priceSol = trade.amountSol / trade.amountTokens;
    }
  }
  return trade;
}

// ── Handle Trade ──────────────────────────────────────────────
async function handleTrade(trade) {
  if (!trade.walletAddress) return null;
  await enrichWithSolPrice(trade);

  const stmt = db.prepare(`
    INSERT INTO trades (wallet_address, token_address, token_symbol, token_name, action, amount_sol, amount_tokens, price_sol, detected_at, tx_signature, dex, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    trade.walletAddress, trade.tokenAddress, trade.tokenSymbol, trade.tokenName,
    trade.type, trade.amountSol, trade.amountTokens, trade.priceSol,
    trade.timestamp, trade.signature, trade.dex || 'unknown', JSON.stringify(trade.rawData)
  );

  if (trade.type === 'BUY') {
    db.prepare(`INSERT INTO paper_positions (wallet_address, token_address, token_symbol, buy_price_sol, buy_amount_sol, buy_amount_tokens, buy_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')`)
      .run(trade.walletAddress, trade.tokenAddress, trade.tokenSymbol, trade.priceSol, trade.amountSol, trade.amountTokens, trade.timestamp);
    const dexTag = trade.dex !== 'unknown' ? ` [${trade.dex}]` : '';
    console.log(`📈 BUY: ${trade.tokenSymbol}${dexTag} @ ${trade.priceSol.toFixed(12)} SOL (${trade.amountSol.toFixed(4)} SOL) from ${trade.walletAddress.slice(0, 6)}...`);
  }

  if (trade.type === 'SELL') {
    const position = db.prepare(`SELECT * FROM paper_positions WHERE wallet_address = ? AND token_address = ? AND status = 'OPEN' ORDER BY buy_time ASC LIMIT 1`)
      .get(trade.walletAddress, trade.tokenAddress);
    if (position) {
      const pnlSol = trade.amountSol - position.buy_amount_sol;
      const pnlPercent = position.buy_price_sol > 0 ? ((trade.priceSol - position.buy_price_sol) / position.buy_price_sol) * 100 : 0;
      db.prepare(`UPDATE paper_positions SET sell_price_sol = ?, sell_amount_sol = ?, sell_time = ?, pnl_sol = ?, pnl_percent = ?, status = 'CLOSED' WHERE id = ?`)
        .run(trade.priceSol, trade.amountSol, trade.timestamp, pnlSol, pnlPercent, position.id);
      const emoji = pnlSol >= 0 ? '💰' : '📉';
      const dexTag = trade.dex !== 'unknown' ? ` [${trade.dex}]` : '';
      console.log(`${emoji} SELL: ${trade.tokenSymbol}${dexTag} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%) from ${trade.walletAddress.slice(0, 6)}...`);
    } else {
      console.log(`⚠️  SELL: ${trade.tokenSymbol} but no open position`);
    }
  }

  events.emit('trade', trade);
  return trade;
}

// ── Poll Wallet (with rate limiting) ──────────────────────────
async function pollWallet(walletAddress) {
  try {
    await waitForToken(3); // weight=3

    const result = await fetchWalletActivity(walletAddress, 20);
    const activities = result?.activities || [];
    const lastSig = lastSeenTx.get(walletAddress);

    let newActivities = [];
    for (const act of activities) {
      if (act.tx_hash === lastSig) break;
      newActivities.push(act);
    }

    if (newActivities.length > 0) {
      lastSeenTx.set(walletAddress, newActivities[0].tx_hash);
      for (const act of newActivities.reverse()) {
        const trade = parseActivity(act, walletAddress);
        if (trade) await handleTrade(trade);
      }
    }
  } catch (err) {
    if (err.message?.includes('429')) {
      // Rate limited — back off
      bucket.tokens = 0;
      await new Promise(r => setTimeout(r, 5000));
    } else {
      console.error(`Error polling ${walletAddress.slice(0, 8)}: ${err.message}`);
    }
  }
}

// ── Monitor Loop ──────────────────────────────────────────────
let monitorInterval = null;
let isRunning = false;
let pollIndex = 0;

async function monitorTick() {
  const wallets = db.prepare('SELECT address FROM tracked_wallets WHERE active = 1').all();
  if (wallets.length === 0) return;

  // Poll 6 wallets per tick (weight 3 × 6 = 18, under 20 capacity)
  const batchSize = 6;
  const start = pollIndex % wallets.length;
  const batch = [];
  for (let i = 0; i < batchSize && i < wallets.length; i++) {
    batch.push(wallets[(start + i) % wallets.length]);
  }
  pollIndex += batchSize;

  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] Polling ${batch.map(w => w.address.slice(0,6)).join(', ')}...`);

  await Promise.allSettled(batch.map(w => pollWallet(w.address)));
}

function startMonitor() {
  if (isRunning) return;
  isRunning = true;
  console.log(`🔍 Starting GMGN monitor (6 per tick, ${POLL_INTERVAL}ms interval, rate-limited)`);

  if (gmgnKeys.length === 0) {
    console.log('⚠️  No GMGN_API_KEYS set.');
    isRunning = false;
    return;
  }

  // Seed wallets with rate limiting
  (async () => {
    const wallets = db.prepare('SELECT address FROM tracked_wallets WHERE active = 1').all();
    console.log(`  Seeding ${wallets.length} wallets...`);
    for (const w of wallets) {
      try {
        await waitForToken(3);
        const result = await fetchWalletActivity(w.address, 1);
        const activities = result?.activities || [];
        if (activities.length > 0) {
          lastSeenTx.set(w.address, activities[0].tx_hash);
          console.log(`  ✓ ${w.address.slice(0, 8)}...`);
        }
      } catch (e) {
        console.error(`  ✗ ${w.address.slice(0, 8)}... ${e.message}`);
      }
    }
    console.log('✅ Monitor ready. Watching for trades...\n');
  })();

  monitorInterval = setInterval(monitorTick, POLL_INTERVAL);
}

function stopMonitor() {
  isRunning = false;
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  console.log('⏹ Monitor stopped');
}

function getMonitorStatus() {
  return {
    running: isRunning,
    pollInterval: POLL_INTERVAL,
    walletsTracked: lastSeenTx.size,
    lastSeen: Object.fromEntries(lastSeenTx),
    source: 'gmgn',
  };
}

module.exports = { startMonitor, stopMonitor, getMonitorStatus, events };
