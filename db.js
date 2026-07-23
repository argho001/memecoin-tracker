const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'tracker.db'));

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE NOT NULL,
    label TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT DEFAULT 'UNKNOWN',
    token_name TEXT DEFAULT '',
    action TEXT NOT NULL, -- 'BUY' or 'SELL'
    amount_sol REAL DEFAULT 0,
    amount_tokens REAL DEFAULT 0,
    price_sol REAL DEFAULT 0,
    market_cap REAL DEFAULT 0,
    liquidity REAL DEFAULT 0,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    tx_signature TEXT DEFAULT '',
    dex TEXT DEFAULT 'unknown',
    raw_data TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS paper_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT DEFAULT 'UNKNOWN',
    buy_price_sol REAL NOT NULL,
    buy_amount_sol REAL NOT NULL,
    buy_amount_tokens REAL NOT NULL,
    buy_time DATETIME NOT NULL,
    sell_price_sol REAL DEFAULT NULL,
    sell_amount_sol REAL DEFAULT NULL,
    sell_time DATETIME DEFAULT NULL,
    pnl_sol REAL DEFAULT NULL,
    pnl_percent REAL DEFAULT NULL,
    status TEXT DEFAULT 'OPEN', -- 'OPEN' or 'CLOSED'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_address);
  CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
  CREATE INDEX IF NOT EXISTS idx_positions_status ON paper_positions(status);
  CREATE INDEX IF NOT EXISTS idx_positions_wallet ON paper_positions(wallet_address);
`);

// Migration: add dex column if missing
try {
  db.prepare('SELECT dex FROM trades LIMIT 1').get();
} catch (e) {
  db.exec("ALTER TABLE trades ADD COLUMN dex TEXT DEFAULT 'unknown'");
}

module.exports = db;
