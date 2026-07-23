const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Create tables
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tracked_wallets (
        id SERIAL PRIMARY KEY,
        address TEXT UNIQUE NOT NULL,
        label TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT DEFAULT 'UNKNOWN',
        token_name TEXT DEFAULT '',
        action TEXT NOT NULL,
        amount_sol REAL DEFAULT 0,
        amount_tokens REAL DEFAULT 0,
        price_sol REAL DEFAULT 0,
        market_cap REAL DEFAULT 0,
        liquidity REAL DEFAULT 0,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tx_signature TEXT DEFAULT '',
        dex TEXT DEFAULT 'unknown',
        raw_data TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS paper_positions (
        id SERIAL PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT DEFAULT 'UNKNOWN',
        buy_price_sol REAL NOT NULL,
        buy_amount_sol REAL NOT NULL,
        buy_amount_tokens REAL NOT NULL,
        buy_time TIMESTAMP NOT NULL,
        sell_price_sol REAL DEFAULT NULL,
        sell_amount_sol REAL DEFAULT NULL,
        sell_time TIMESTAMP DEFAULT NULL,
        pnl_sol REAL DEFAULT NULL,
        pnl_percent REAL DEFAULT NULL,
        status TEXT DEFAULT 'OPEN',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON paper_positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_wallet ON paper_positions(wallet_address);
    `);
    console.log('PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

// Initialize tables on load
initDB().catch(err => console.error('DB init error:', err.message));

// Wrapper to match SQLite API style
const db = {
  prepare(sql) {
    // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
    let paramIndex = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
    
    return {
      run(...params) {
        return pool.query(pgSql, params).then(r => ({
          changes: r.rowCount,
          lastInsertRowid: r.rows[0]?.id || 0,
        })).catch(err => {
          console.error('DB run error:', err.message, pgSql);
          throw err;
        });
      },
      get(...params) {
        return pool.query(pgSql, params).then(r => r.rows[0] || null).catch(err => {
          console.error('DB get error:', err.message, pgSql);
          throw err;
        });
      },
      all(...params) {
        return pool.query(pgSql, params).then(r => r.rows).catch(err => {
          console.error('DB all error:', err.message, pgSql);
          throw err;
        });
      },
    };
  },
  exec(sql) {
    return pool.query(sql).catch(err => {
      console.error('DB exec error:', err.message);
      throw err;
    });
  },
};

module.exports = db;
