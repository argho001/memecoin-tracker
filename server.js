require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('./db');
const { startMonitor, stopMonitor, getMonitorStatus, events: monitorEvents } = require('./monitor');
const { TradeExecutor } = require('./executor');

// Initialize executor (paper mode by default)
const executor = new TradeExecutor({
  mode: 'paper', // 'paper' or 'live'
  maxPositionSol: 1.0,
  slippageBps: 100,
  stopLossPercent: 50,
  takeProfitPercent: 500,
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helius Webhook Receiver ──────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const event of events) {
    try {
      await processWebhookEvent(event);
    } catch (e) {
      console.error('Webhook error:', e.message);
    }
  }

  res.status(200).json({ ok: true });
});

async function processWebhookEvent(tx) {
  if (!tx || !tx.signature) return;

  const walletAddress = tx.feePayer || '';
  if (!walletAddress) return;

  // Check if this wallet is tracked
  const tracked = db.prepare('SELECT * FROM tracked_wallets WHERE address = ? AND active = 1').get(walletAddress);
  if (!tracked) return;

  // Parse swap
  const swap = parseSwapFromWebhook(tx, walletAddress);
  if (!swap) return;

  // FILTER: Skip dust trades (minimum 0.05 SOL)
  if (swap.amountSol < 0.05) return;

  // Save trade
  const stmt = db.prepare(`
    INSERT INTO trades (wallet_address, token_address, token_symbol, token_name, action, amount_sol, amount_tokens, price_sol, detected_at, tx_signature, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    swap.walletAddress,
    swap.tokenAddress,
    swap.tokenSymbol || 'UNKNOWN',
    swap.tokenName || '',
    swap.type,
    swap.amountSol,
    swap.amountTokens,
    swap.priceSol,
    swap.timestamp,
    swap.signature,
    JSON.stringify(tx)
  );

  // Update paper positions
  if (swap.type === 'BUY') {
    db.prepare(`
      INSERT INTO paper_positions (wallet_address, token_address, token_symbol, buy_price_sol, buy_amount_sol, buy_amount_tokens, buy_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `).run(swap.walletAddress, swap.tokenAddress, swap.tokenSymbol || 'UNKNOWN', swap.priceSol, swap.amountSol, swap.amountTokens, swap.timestamp);

    console.log(`📈 BUY: ${swap.tokenSymbol} @ ${swap.priceSol.toFixed(10)} SOL (${swap.amountSol.toFixed(4)} SOL) from ${walletAddress.slice(0, 8)}...`);
  }

  if (swap.type === 'SELL') {
    const position = db.prepare(`
      SELECT * FROM paper_positions
      WHERE wallet_address = ? AND token_address = ? AND status = 'OPEN'
      ORDER BY buy_time ASC LIMIT 1
    `).get(swap.walletAddress, swap.tokenAddress);

    if (position) {
      const pnlSol = swap.amountSol - position.buy_amount_sol;
      const pnlPercent = position.buy_price_sol > 0 ? ((swap.priceSol - position.buy_price_sol) / position.buy_price_sol) * 100 : 0;

      db.prepare(`
        UPDATE paper_positions
        SET sell_price_sol = ?, sell_amount_sol = ?, sell_time = ?, pnl_sol = ?, pnl_percent = ?, status = 'CLOSED'
        WHERE id = ?
      `).run(swap.priceSol, swap.amountSol, swap.timestamp, pnlSol, pnlPercent, position.id);

      const emoji = pnlSol >= 0 ? '💰' : '📉';
      console.log(`${emoji} SELL: ${swap.tokenSymbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
    }
  }

  // Execute trade (paper or live)
  const result = await executor.processTrade(swap);
  if (result) {
    swap.executionResult = result;
  }

  // Broadcast to dashboard
  broadcast('NEW_TRADE', swap);
}

function parseSwapFromWebhook(tx, walletAddress) {
  const result = {
    signature: tx.signature,
    timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : new Date().toISOString(),
    type: null,
    tokenAddress: null,
    tokenSymbol: null,
    tokenName: null,
    amountSol: 0,
    amountTokens: 0,
    priceSol: 0,
    walletAddress,
  };

  if (tx.type === 'SWAP') {
    const solOut = (tx.nativeTransfers || [])
      .filter(t => t.fromUserAccount === walletAddress)
      .reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;

    const solIn = (tx.nativeTransfers || [])
      .filter(t => t.toUserAccount === walletAddress)
      .reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;

    const tokenIn = (tx.tokenTransfers || []).find(t => t.toUserAccount === walletAddress);
    const tokenOut = (tx.tokenTransfers || []).find(t => t.fromUserAccount === walletAddress);

    if (solOut > 0 && tokenIn) {
      result.type = 'BUY';
      result.tokenAddress = tokenIn.mint;
      result.amountSol = solOut;
      result.amountTokens = tokenIn.tokenAmount || 0;
      if (result.amountTokens > 0) result.priceSol = result.amountSol / result.amountTokens;
    } else if (solIn > 0 && tokenOut) {
      result.type = 'SELL';
      result.tokenAddress = tokenOut.mint;
      result.amountSol = solIn;
      result.amountTokens = tokenOut.tokenAmount || 0;
      if (result.amountTokens > 0) result.priceSol = result.amountSol / result.amountTokens;
    }

    if (tx.description) {
      const match = tx.description.match(/(\w+)\s+(?:for|of)/i);
      if (match) result.tokenSymbol = match[1];
    }
  }

  return result.type ? result : null;
}

// ─── WebSocket for live updates ────────────────────────────────
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// Listen for monitor trade events and broadcast via WebSocket
monitorEvents.on('trade', (trade) => {
  broadcast('NEW_TRADE', trade);
});

// ─── API Routes ────────────────────────────────────────────────

// --- Tracked Wallets ---
app.get('/api/wallets', (req, res) => {
  const wallets = db.prepare('SELECT * FROM tracked_wallets ORDER BY created_at DESC').all();
  res.json(wallets);
});

app.post('/api/wallets', (req, res) => {
  const { address, label } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });

  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO tracked_wallets (address, label) VALUES (?, ?)');
    const result = stmt.run(address.trim(), label || '');
    if (result.changes === 0) {
      return res.status(409).json({ error: 'Wallet already tracked' });
    }
    res.json({ id: result.lastInsertRowid, address: address.trim(), label: label || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/wallets/:id', (req, res) => {
  db.prepare('DELETE FROM tracked_wallets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/wallets/:id', (req, res) => {
  const { label, active } = req.body;
  const updates = [];
  const values = [];
  if (label !== undefined) { updates.push('label = ?'); values.push(label); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE tracked_wallets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// --- Trades ---
app.get('/api/trades', (req, res) => {
  const { wallet, token, limit = 100, offset = 0 } = req.query;
  let sql = 'SELECT * FROM trades WHERE 1=1';
  const params = [];

  if (wallet) { sql += ' AND wallet_address = ?'; params.push(wallet); }
  if (token) { sql += ' AND token_address = ?'; params.push(token); }

  sql += ' ORDER BY detected_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const trades = db.prepare(sql).all(...params);
  res.json(trades);
});

// --- Paper Positions ---
app.get('/api/positions', (req, res) => {
  const { status, wallet, limit = 100 } = req.query;
  let sql = 'SELECT * FROM paper_positions WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status.toUpperCase()); }
  if (wallet) { sql += ' AND wallet_address = ?'; params.push(wallet); }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const positions = db.prepare(sql).all(...params);
  res.json(positions);
});

// --- Stats ---
app.get('/api/stats', (req, res) => {
  const totalTrades = db.prepare('SELECT COUNT(*) as count FROM trades').get().count;
  const totalBuys = db.prepare("SELECT COUNT(*) as count FROM trades WHERE action = 'BUY'").get().count;
  const totalSells = db.prepare("SELECT COUNT(*) as count FROM trades WHERE action = 'SELL'").get().count;

  const openPositions = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status = 'OPEN'").get().count;
  const closedPositions = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status = 'CLOSED'").get().count;

  const pnlStats = db.prepare(`
    SELECT
      COALESCE(SUM(pnl_sol), 0) as total_pnl,
      COALESCE(AVG(pnl_percent), 0) as avg_pnl_percent,
      COUNT(CASE WHEN pnl_sol > 0 THEN 1 END) as winning_trades,
      COUNT(CASE WHEN pnl_sol < 0 THEN 1 END) as losing_trades,
      COALESCE(MAX(pnl_sol), 0) as best_trade,
      COALESCE(MIN(pnl_sol), 0) as worst_trade
    FROM paper_positions WHERE status = 'CLOSED'
  `).get();

  const winRate = closedPositions > 0 ? (pnlStats.winning_trades / closedPositions) * 100 : 0;

  // Per-wallet stats
  const walletStats = db.prepare(`
    SELECT
      wallet_address,
      COUNT(*) as total_trades,
      COUNT(CASE WHEN pnl_sol > 0 THEN 1 END) as wins,
      COUNT(CASE WHEN pnl_sol < 0 THEN 1 END) as losses,
      COALESCE(SUM(pnl_sol), 0) as total_pnl,
      COALESCE(AVG(pnl_percent), 0) as avg_pnl_percent
    FROM paper_positions
    WHERE status = 'CLOSED'
    GROUP BY wallet_address
    ORDER BY total_pnl DESC
  `).all();

  // Top tokens
  const topTokens = db.prepare(`
    SELECT
      token_symbol,
      token_address,
      COUNT(*) as trade_count,
      COALESCE(SUM(pnl_sol), 0) as total_pnl,
      COALESCE(AVG(pnl_percent), 0) as avg_pnl_percent
    FROM paper_positions
    WHERE status = 'CLOSED'
    GROUP BY token_address
    ORDER BY total_pnl DESC
    LIMIT 10
  `).all();

  res.json({
    overview: {
      totalTrades,
      totalBuys,
      totalSells,
      openPositions,
      closedPositions,
    },
    performance: {
      totalPnl: pnlStats.total_pnl,
      avgPnlPercent: pnlStats.avg_pnl_percent,
      winRate,
      winningTrades: pnlStats.winning_trades,
      losingTrades: pnlStats.losing_trades,
      bestTrade: pnlStats.best_trade,
      worstTrade: pnlStats.worst_trade,
    },
    walletStats,
    topTokens,
    monitor: getMonitorStatus(),
  });
});

// --- Monitor Control ---
app.post('/api/monitor/start', (req, res) => {
  startMonitor();
  res.json({ ok: true, status: getMonitorStatus() });
});

app.post('/api/monitor/stop', (req, res) => {
  stopMonitor();
  res.json({ ok: true, status: getMonitorStatus() });
});

app.get('/api/monitor/status', (req, res) => {
  res.json(getMonitorStatus());
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
  res.json({
    hasHeliusKey: !!process.env.HELIUS_API_KEY,
    pollInterval: parseInt(process.env.POLL_INTERVAL_MS) || 5000,
    defaultPositionSol: parseFloat(process.env.DEFAULT_POSITION_SOL) || 1.0,
    stopLoss: parseInt(process.env.STOP_LOSS_PERCENT) || 50,
    takeProfit: parseInt(process.env.TAKE_PROFIT_PERCENT) || 500,
  });
});

// --- Clear All Data ---
app.post('/api/clear', (req, res) => {
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM paper_positions').run();
  db.prepare('DELETE FROM tracked_wallets').run();
  res.json({ ok: true });
});

// --- Executor Control ---
app.get('/api/executor/status', (req, res) => {
  res.json(executor.getStatus());
});

app.post('/api/executor/mode', (req, res) => {
  const { mode } = req.body;
  if (!['paper', 'live'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be paper or live' });
  }
  executor.mode = mode;
  res.json({ ok: true, mode });
});

app.post('/api/executor/config', (req, res) => {
  const { maxPositionSol, slippageBps, stopLossPercent, takeProfitPercent } = req.body;
  if (maxPositionSol !== undefined) executor.maxPositionSol = maxPositionSol;
  if (slippageBps !== undefined) executor.slippageBps = slippageBps;
  if (stopLossPercent !== undefined) executor.stopLossPercent = stopLossPercent;
  if (takeProfitPercent !== undefined) executor.takeProfitPercent = takeProfitPercent;
  res.json(executor.getStatus());
});

// --- Seed demo data (for testing without API key) ---
app.post('/api/demo/seed', (req, res) => {
  const demoWallets = [
    { address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', label: 'Whale #1' },
    { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', label: 'Smart Money #2' },
    { address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', label: 'Degen Trader #3' },
  ];

  const insertWallet = db.prepare('INSERT OR IGNORE INTO tracked_wallets (address, label) VALUES (?, ?)');
  for (const w of demoWallets) {
    insertWallet.run(w.address, w.label);
  }

  // Generate demo trades
  const demoTokens = [
    { symbol: 'BONK', name: 'Bonk', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    { symbol: 'WIF', name: 'dogwifhat', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
    { symbol: 'POPCAT', name: 'Popcat', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
    { symbol: 'MEW', name: 'cat in a worlds dog', address: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79yvzG49Td4Mbpump' },
    { symbol: 'GUMMY', name: 'GUMMY', address: 'GUMMYbJNd1qi4EuiRdx8sW6a2YdWJHQjwjN8MFqZT54G' },
    { symbol: 'MYRO', name: 'Myro', address: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
  ];

  const insertTrade = db.prepare(`
    INSERT INTO trades (wallet_address, token_address, token_symbol, token_name, action, amount_sol, amount_tokens, price_sol, detected_at, tx_signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPosition = db.prepare(`
    INSERT INTO paper_positions (wallet_address, token_address, token_symbol, buy_price_sol, buy_amount_sol, buy_amount_tokens, buy_time, sell_price_sol, sell_amount_sol, sell_time, pnl_sol, pnl_percent, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Generate realistic demo data
  const now = Date.now();
  let sigCounter = 0;

  for (let i = 0; i < 20; i++) {
    const wallet = demoWallets[i % demoWallets.length];
    const token = demoTokens[i % demoTokens.length];
    const buyPrice = (Math.random() * 0.00001 + 0.000001);
    const buyAmountSol = Math.random() * 3 + 0.5;
    const buyAmountTokens = buyAmountSol / buyPrice;
    const buyTime = new Date(now - (20 - i) * 3600000 * (1 + Math.random())).toISOString();

    sigCounter++;
    const sig = `demo_sig_${sigCounter}_${Date.now()}`;

    insertTrade.run(
      wallet.address, token.address, token.symbol, token.name, 'BUY',
      buyAmountSol, buyAmountTokens, buyPrice, buyTime, sig
    );

    // 70% chance already sold
    if (Math.random() > 0.3) {
      const pnlMult = Math.random() > 0.35 ? (1 + Math.random() * 8) : (0.1 + Math.random() * 0.6);
      const sellPrice = buyPrice * pnlMult;
      const sellAmountTokens = buyAmountTokens * (0.9 + Math.random() * 0.1);
      const sellAmountSol = sellAmountTokens * sellPrice;
      const sellTime = new Date(new Date(buyTime).getTime() + Math.random() * 7200000).toISOString();
      const pnlSol = sellAmountSol - buyAmountSol;
      const pnlPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

      sigCounter++;
      const sellSig = `demo_sig_${sigCounter}_${Date.now()}`;

      insertTrade.run(
        wallet.address, token.address, token.symbol, token.name, 'SELL',
        sellAmountSol, sellAmountTokens, sellPrice, sellTime, sellSig
      );

      insertPosition.run(
        wallet.address, token.address, token.symbol,
        buyPrice, buyAmountSol, buyAmountTokens, buyTime,
        sellPrice, sellAmountSol, sellTime,
        pnlSol, pnlPercent, 'CLOSED'
      );
    } else {
      insertPosition.run(
        wallet.address, token.address, token.symbol,
        buyPrice, buyAmountSol, buyAmountTokens, buyTime,
        null, null, null, null, null, 'OPEN'
      );
    }
  }

  res.json({ ok: true, message: 'Demo data seeded', wallets: demoWallets.length, trades: 40 });
});

// ─── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n🚀 Memecoin Paper Trading Dashboard`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/stats`);
  console.log('');

  // Auto-start monitor if API key is set
  if (process.env.HELIUS_API_KEY) {
    startMonitor();
  } else {
    console.log('⚠️  No HELIUS_API_KEY set. Run with API key for live monitoring.');
    console.log('   Visit dashboard and click "Seed Demo Data" to explore.\n');
  }
});
