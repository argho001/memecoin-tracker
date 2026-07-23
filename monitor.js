const axios = require('axios');
const EventEmitter = require('events');
const db = require('./db');

const events = new EventEmitter();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 5000;
const HELIUS_BASE = 'https://api.helius.xyz/v0';

// Track last seen tx per wallet to avoid duplicates
const lastSeenTx = new Map();

/**
 * Fetch recent transactions for a wallet via Helius Enhanced API
 */
async function fetchWalletTransactions(walletAddress, limit = 10) {
  if (!HELIUS_API_KEY) {
    throw new Error('HELIUS_API_KEY not set');
  }

  const url = `${HELIUS_BASE}/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;
  const resp = await axios.get(url, { timeout: 10000 });
  return resp.data || [];
}

/**
 * Parse a Helius enhanced transaction to extract swap info
 */
function parseSwapTransaction(tx, walletAddress) {
  // Helius enhanced transactions have a 'type' field
  // We look for SWAP type or token transfers that indicate a buy/sell

  const result = {
    signature: tx.signature,
    timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : new Date().toISOString(),
    type: null,       // BUY or SELL
    tokenAddress: null,
    tokenSymbol: null,
    tokenName: null,
    amountSol: 0,
    amountTokens: 0,
    priceSol: 0,
    rawData: tx,
  };

  // Method 1: Check if Helius classified it as a SWAP
  if (tx.type === 'SWAP') {
    // Parse native and token transfers
    const nativeTransfers = tx.nativeTransfers || [];
    const tokenTransfers = tx.tokenTransfers || [];

    // SOL going OUT from wallet = buying tokens
    // SOL coming IN to wallet = selling tokens

    const solOut = nativeTransfers
      .filter(t => t.fromUserAccount === walletAddress)
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const solIn = nativeTransfers
      .filter(t => t.toUserAccount === walletAddress)
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    // Find token transfers involving our wallet
    const tokenIn = tokenTransfers.find(t => t.toUserAccount === walletAddress);
    const tokenOut = tokenTransfers.find(t => t.fromUserAccount === walletAddress);

    if (solOut > 0 && tokenIn) {
      // BUYING tokens with SOL
      result.type = 'BUY';
      result.tokenAddress = tokenIn.mint;
      result.amountSol = solOut / 1e9; // lamports to SOL
      result.amountTokens = tokenIn.tokenAmount || 0;
      if (result.amountTokens > 0) {
        result.priceSol = result.amountSol / result.amountTokens;
      }
    } else if (solIn > 0 && tokenOut) {
      // SELLING tokens for SOL
      result.type = 'SELL';
      result.tokenAddress = tokenOut.mint;
      result.amountSol = solIn / 1e9;
      result.amountTokens = tokenOut.tokenAmount || 0;
      if (result.amountTokens > 0) {
        result.priceSol = result.amountSol / result.amountTokens;
      }
    }

    // Try to get token metadata from description or events
    if (tx.description) {
      const descMatch = tx.description.match(/(\w+)\s+(?:for|of)/i);
      if (descMatch) result.tokenSymbol = descMatch[1];
    }

    if (tx.events?.swap) {
      const swapEvent = tx.events.swap;
      if (swapEvent.tokenIn && swapEvent.tokenOut) {
        // Additional swap details
        if (!result.tokenSymbol && swapEvent.tokenOut?.symbol) {
          result.tokenSymbol = swapEvent.tokenOut.symbol;
        }
      }
    }
  }

  // Method 2: Fallback - detect token transfers (for non-SWAP classified txns)
  if (!result.type && tx.tokenTransfers) {
    const relevant = tx.tokenTransfers.filter(
      t => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
    );

    for (const transfer of relevant) {
      if (transfer.toUserAccount === walletAddress) {
        // Receiving tokens - likely a buy (if SOL was sent)
        result.type = 'BUY';
        result.tokenAddress = transfer.mint;
        result.amountTokens = transfer.tokenAmount || 0;
      } else if (transfer.fromUserAccount === walletAddress) {
        // Sending tokens - likely a sell (if SOL was received)
        result.type = 'SELL';
        result.tokenAddress = transfer.mint;
        result.amountTokens = transfer.tokenAmount || 0;
      }
    }

    // Check SOL movement to confirm
    const solSpent = (tx.nativeTransfers || [])
      .filter(t => t.fromUserAccount === walletAddress)
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const solReceived = (tx.nativeTransfers || [])
      .filter(t => t.toUserAccount === walletAddress)
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    if (result.type === 'BUY') {
      result.amountSol = solSpent / 1e9;
    } else if (result.type === 'SELL') {
      result.amountSol = solReceived / 1e9;
    }

    if (result.amountTokens > 0 && result.amountSol > 0) {
      result.priceSol = result.amountSol / result.amountTokens;
    }
  }

  return result.type ? result : null;
}

/**
 * Enrich trade with token metadata (symbol, name)
 */
async function enrichTokenInfo(tokenAddress) {
  try {
    // Try Helius token metadata
    if (HELIUS_API_KEY) {
      const url = `${HELIUS_BASE}/token-metadata?api-key=${HELIUS_API_KEY}`;
      const resp = await axios.post(url, { mintAccounts: [tokenAddress] }, { timeout: 5000 });
      if (resp.data && resp.data[0]) {
        const meta = resp.data[0];
        return {
          symbol: meta.symbol || 'UNKNOWN',
          name: meta.name || '',
        };
      }
    }
  } catch (e) {
    // Silently fail, use defaults
  }
  return { symbol: 'UNKNOWN', name: '' };
}

/**
 * Get current token price in SOL via Jupiter
 */
async function getTokenPriceSol(tokenAddress) {
  try {
    const url = `https://api.jup.ag/price/v2?ids=${tokenAddress}`;
    const resp = await axios.get(url, { timeout: 5000 });
    const data = resp.data?.data?.[tokenAddress];
    if (data?.price) {
      // Jupiter returns price in USD, we need SOL price
      // Get SOL price too
      const solUrl = `https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112`;
      const solResp = await axios.get(solUrl, { timeout: 5000 });
      const solPrice = solResp.data?.data?.['So11111111111111111111111111111111111111112']?.price || 0;
      if (solPrice > 0) {
        return data.price / solPrice;
      }
    }
  } catch (e) {
    // Silently fail
  }
  return 0;
}

/**
 * Handle a detected trade - save to DB and update paper positions
 */
async function handleTrade(trade) {
  // Skip if no wallet address
  if (!trade.walletAddress) return null;

  // Enrich token info if unknown
  if (!trade.tokenSymbol || trade.tokenSymbol === 'UNKNOWN') {
    const info = await enrichTokenInfo(trade.tokenAddress);
    trade.tokenSymbol = info.symbol;
    trade.tokenName = info.name;
  }

  // Insert trade record
  const stmt = db.prepare(`
    INSERT INTO trades (wallet_address, token_address, token_symbol, token_name, action, amount_sol, amount_tokens, price_sol, detected_at, tx_signature, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    trade.walletAddress,
    trade.tokenAddress,
    trade.tokenSymbol,
    trade.tokenName,
    trade.type,
    trade.amountSol,
    trade.amountTokens,
    trade.priceSol,
    trade.timestamp,
    trade.signature,
    JSON.stringify(trade.rawData)
  );

  // Update paper positions
  if (trade.type === 'BUY') {
    // Open a new paper position
    const posStmt = db.prepare(`
      INSERT INTO paper_positions (wallet_address, token_address, token_symbol, buy_price_sol, buy_amount_sol, buy_amount_tokens, buy_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `);
    posStmt.run(
      trade.walletAddress,
      trade.tokenAddress,
      trade.tokenSymbol,
      trade.priceSol,
      trade.amountSol,
      trade.amountTokens,
      trade.timestamp
    );
    console.log(`📈 BUY signal: ${trade.tokenSymbol} @ ${trade.priceSol.toFixed(12)} SOL (${trade.amountSol.toFixed(4)} SOL) from ${trade.walletAddress.slice(0, 6)}...`);
  }

  if (trade.type === 'SELL') {
    // Find matching open position and close it
    const position = db.prepare(`
      SELECT * FROM paper_positions
      WHERE wallet_address = ? AND token_address = ? AND status = 'OPEN'
      ORDER BY buy_time ASC LIMIT 1
    `).get(trade.walletAddress, trade.tokenAddress);

    if (position) {
      const pnlSol = trade.amountSol - position.buy_amount_sol;
      const pnlPercent = ((trade.priceSol - position.buy_price_sol) / position.buy_price_sol) * 100;

      const updateStmt = db.prepare(`
        UPDATE paper_positions
        SET sell_price_sol = ?, sell_amount_sol = ?, sell_time = ?, pnl_sol = ?, pnl_percent = ?, status = 'CLOSED'
        WHERE id = ?
      `);
      updateStmt.run(trade.priceSol, trade.amountSol, trade.timestamp, pnlSol, pnlPercent, position.id);

      const emoji = pnlSol >= 0 ? '💰' : '📉';
      console.log(`${emoji} SELL signal: ${trade.tokenSymbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%) from ${trade.walletAddress.slice(0, 6)}...`);
    } else {
      console.log(`⚠️  SELL signal for ${trade.tokenSymbol} but no open position found`);
    }
  }

  // Emit event for WebSocket broadcast
  events.emit('trade', trade);

  return trade;
}

/**
 * Poll a single wallet for new transactions
 */
async function pollWallet(walletAddress) {
  try {
    const txns = await fetchWalletTransactions(walletAddress, 5);
    const lastSig = lastSeenTx.get(walletAddress);

    let newTxns = [];
    for (const tx of txns) {
      if (tx.signature === lastSig) break;
      newTxns.push(tx);
    }

    if (newTxns.length > 0) {
      lastSeenTx.set(walletAddress, newTxns[0].signature);

      // Process newest first (they come newest-first from API)
      for (const tx of newTxns.reverse()) {
        const swap = parseSwapTransaction(tx, walletAddress);
        if (swap) {
          await handleTrade(swap);
        }
      }
    }
  } catch (err) {
    console.error(`Error polling wallet ${walletAddress.slice(0, 8)}...: ${err.message}`);
  }
}

/**
 * Main monitoring loop
 */
let monitorInterval = null;
let isRunning = false;
let pollIndex = 0;

async function monitorTick() {
  const wallets = db.prepare('SELECT address FROM tracked_wallets WHERE active = 1').all();
  if (wallets.length === 0) return;

  // Poll only 3 wallets per tick (rotate through them)
  // With 5s interval and 3 wallets per tick, we poll each wallet every 50s
  const batchSize = 3;
  const start = pollIndex % wallets.length;
  const batch = [];
  for (let i = 0; i < batchSize && i < wallets.length; i++) {
    batch.push(wallets[(start + i) % wallets.length]);
  }
  pollIndex += batchSize;

  for (const w of batch) {
    await pollWallet(w.address);
    await new Promise(r => setTimeout(r, 500)); // 500ms delay between each
  }
}

function startMonitor() {
  if (isRunning) return;
  isRunning = true;
  console.log(`🔍 Starting wallet monitor (batch polling, 3 wallets per tick)`);

  // Seed wallets slowly to avoid rate limits
  (async () => {
    const wallets = db.prepare('SELECT address FROM tracked_wallets WHERE active = 1').all();
    console.log(`  Seeding ${wallets.length} wallets (with delays)...`);
    for (const w of wallets) {
      try {
        const txns = await fetchWalletTransactions(w.address, 1);
        if (txns.length > 0) {
          lastSeenTx.set(w.address, txns[0].signature);
          console.log(`  ✓ ${w.address.slice(0, 8)}...`);
        }
      } catch (e) {
        console.error(`  ✗ ${w.address.slice(0, 8)}... ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000)); // 1s between each seed
    }
    console.log('✅ Monitor ready. Watching for new trades...\n');
  })();

  monitorInterval = setInterval(monitorTick, 5000);
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
  };
}

module.exports = { startMonitor, stopMonitor, getMonitorStatus, events };
