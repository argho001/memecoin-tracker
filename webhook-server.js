require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HELIUS_KEY = proces…KEY;
const HELIUS = `https://api.helius.xyz/v0`;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // Your public URL

// ─── WebSocket for live dashboard updates ──────────────────────
const wsClients = new Set();
wss.on('connection', (ws) => { wsClients.add(ws); ws.on('close', () => wsClients.delete(ws)); });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Helius Webhook Receiver ──────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const event of events) {
    try {
      await processWebhookEvent(event);
    } catch (e) {
      console.error('Webhook processing error:', e.message);
    }
  }

  res.status(200).json({ ok: true });
});

async function processWebhookEvent(event) {
  // Helius enhanced webhook format
  const tx = event;
  if (!tx || !tx.signature) return;

  const walletAddress = tx.feePayer || '';
  if (!walletAddress) return;

  // Check if this wallet is tracked
  const tracked = db.prepare('SELECT * FROM tracked_wallets WHERE address = ? AND active = 1').get(walletAddress);
  if (!tracked) return;

  // Parse swap
  const swap = parseSwapFromWebhook(tx, walletAddress);
  if (!swap) return;

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

    // Get token symbol from description
    if (tx.description) {
      const match = tx.description.match(/(\w+)\s+(?:for|of)/i);
      if (match) result.tokenSymbol = match[1];
    }
  }

  return result.type ? result : null;
}

// ─── Register/Update Helius Webhook ────────────────────────────
async function registerWebhook() {
  if (!HELIUS_KEY) {
    console.log('⚠️  No HELIUS_API_KEY set');
    return;
  }

  const wallets = db.prepare('SELECT address FROM tracked_wallets WHERE active = 1').all().map(w => w.address);

  if (wallets.length === 0) {
    console.log('⚠️  No wallets to track');
    return;
  }

  // Check existing webhooks
  try {
    const existing = await axios.get(`${HELIUS}/webhooks?api-key=***`);
    const webhooks = existing.data || [];

    // Delete old webhooks
    for (const wh of webhooks) {
      if (wh.webhookURL && wh.webhookURL.includes('webhook')) {
        await axios.delete(`${HELIUS}/webhooks/${wh.webhookID}?api-key=***`);
        console.log(`  Deleted old webhook: ${wh.webhookID}`);
      }
    }
  } catch (e) {
    // Ignore
  }

  // Create new webhook
  const webhookUrl = WEBHOOK_URL || `http://localhost:${PORT}/api/webhook`;

  try {
    const resp = await axios.post(`${HELIUS}/webhooks?api-key=***`, {
      webhookURL: webhookUrl,
      transactionTypes: ['SWAP'],
      accountAddresses: wallets,
      webhookType: 'enhanced',
    });

    console.log(`\n✅ Webhook registered!`);
    console.log(`   ID: ${resp.data.webhookID}`);
    console.log(`   URL: ${webhookUrl}`);
    console.log(`   Tracking: ${wallets.length} wallets\n`);
  } catch (e) {
    console.error(`❌ Webhook registration failed: ${e.message}`);
    if (e.response?.data) console.error(JSON.stringify(e.response.data));
  }
}

// ─── API Routes ────────────────────────────────────────────────
app.get('/api/wallets', (req, res) => {
  res.json(db.prepare('SELECT * FROM tracked_wallets ORDER BY created_at DESC').all());
});

app.post('/api/wallets', (req, res) => {
  const { address, label } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const r = db.prepare('INSERT OR IGNORE INTO tracked_wallets (address, label) VALUES (?, ?)').run(address.trim(), label || '');
    if (r.changes === 0) return res.status(409).json({ error: 'Already tracked' });
    res.json({ id: r.lastInsertRowid, address: address.trim(), label: label || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/wallets/:id', (req, res) => {
  db.prepare('DELETE FROM tracked_wallets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/wallets/:id', (req, res) => {
  const { label, active } = req.body;
  const updates = []; const values = [];
  if (label !== undefined) { updates.push('label = ?'); values.push(label); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE tracked_wallets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

app.get('/api/trades', (req, res) => {
  const { wallet, limit = 100 } = req.query;
  let sql = 'SELECT * FROM trades WHERE 1=1';
  const params = [];
  if (wallet) { sql += ' AND wallet_address = ?'; params.push(wallet); }
  sql += ' ORDER BY detected_at DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/positions', (req, res) => {
  const { status, limit = 100 } = req.query;
  let sql = 'SELECT * FROM paper_positions WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status.toUpperCase()); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/stats', (req, res) => {
  const totalTrades = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
  const totalBuys = db.prepare("SELECT COUNT(*) as c FROM trades WHERE action='BUY'").get().c;
  const totalSells = db.prepare("SELECT COUNT(*) as c FROM trades WHERE action='SELL'").get().c;
  const openPos = db.prepare("SELECT COUNT(*) as c FROM paper_positions WHERE status='OPEN'").get().c;
  const closedPos = db.prepare("SELECT COUNT(*) as c FROM paper_positions WHERE status='CLOSED'").get().c;

  const pnl = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol),0) as total_pnl, COALESCE(AVG(pnl_percent),0) as avg_pnl,
    COUNT(CASE WHEN pnl_sol>0 THEN 1 END) as wins, COUNT(CASE WHEN pnl_sol<0 THEN 1 END) as losses,
    COALESCE(MAX(pnl_sol),0) as best, COALESCE(MIN(pnl_sol),0) as worst
    FROM paper_positions WHERE status='CLOSED'
  `).get();

  const winRate = closedPos > 0 ? (pnl.wins / closedPos) * 100 : 0;

  const walletStats = db.prepare(`
    SELECT wallet_address, COUNT(*) as trades, COUNT(CASE WHEN pnl_sol>0 THEN 1 END) as wins,
    COUNT(CASE WHEN pnl_sol<0 THEN 1 END) as losses, COALESCE(SUM(pnl_sol),0) as total_pnl,
    COALESCE(AVG(pnl_percent),0) as avg_pnl
    FROM paper_positions WHERE status='CLOSED' GROUP BY wallet_address ORDER BY total_pnl DESC
  `).all();

  res.json({
    overview: { totalTrades, totalBuys, totalSells, openPositions: openPos, closedPositions: closedPos },
    performance: { totalPnl: pnl.total_pnl, avgPnlPercent: pnl.avg_pnl, winRate, winningTrades: pnl.wins, losingTrades: pnl.losses, bestTrade: pnl.best, worstTrade: pnl.worst },
    walletStats,
  });
});

app.post('/api/clear', (req, res) => {
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM paper_positions').run();
  db.prepare('DELETE FROM tracked_wallets').run();
  res.json({ ok: true });
});

app.post('/api/demo/seed', (req, res) => {
  // ... same seed logic ...
  res.json({ ok: true });
});

app.post('/api/webhook/register', async (req, res) => {
  await registerWebhook();
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🚀 Whale Tracker Dashboard (Webhook Mode)`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Webhook endpoint: http://localhost:${PORT}/api/webhook\n`);

  if (HELIUS_KEY) {
    await registerWebhook();
  } else {
    console.log('⚠️  Set HELIUS_API_KEY in .env to enable live monitoring\n');
  }
});
