# Memecoin Tracker — GMGN Edition

Real-time Solana memecoin copy-trading bot. Tracks whale wallets via GMGN API, detects BUY/SELL trades, and paper trades to measure profitability.

## Features

- **Real-time wallet monitoring** via GMGN API (1-15s detection)
- **Multi-key rotation** — use multiple API keys to maximize rate limits
- **Rate limiter** — built-in leaky bucket to stay within GMGN limits
- **Auto-detect BUY/SELL** on Pump.fun, Raydium, Jupiter, etc.
- **Paper trading** — tracks entry/exit prices, calculates P&L
- **Live dashboard** with WebSocket updates
- **Wallet leaderboard** — see which tracked wallets are profitable

## Quick Start

```bash
# 1. Install
npm install

# 2. Get GMGN API key(s)
#    https://gmgn.ai/ai

# 3. Configure
cp .env.example .env
# Edit .env with your API keys

# 4. Run
npm start

# 5. Open dashboard
#    http://localhost:3000
```

## Deploy to Railway

1. Push to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub repo
4. Add Environment Variables:
   - `GMGN_API_KEYS` = your API keys (comma-separated)
5. Deploy!

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GMGN_API_KEYS` | — | GMGN API keys (comma-separated for rotation) |
| `PORT` | 3000 | Server port (Railway sets this automatically) |
| `POLL_INTERVAL_MS` | 3000 | Polling interval in ms |
| `DEFAULT_POSITION_SOL` | 1.0 | Paper trade position size |
| `STOP_LOSS_PERCENT` | 50 | Stop loss threshold |
| `TAKE_PROFIT_PERCENT` | 500 | Take profit threshold |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/wallets` | List tracked wallets |
| POST | `/api/wallets` | Add wallet `{address, label}` |
| DELETE | `/api/wallets/:id` | Remove wallet |
| GET | `/api/trades` | Get trade history |
| GET | `/api/positions` | Get paper positions |
| GET | `/api/stats` | Performance stats |
| POST | `/api/monitor/start` | Start monitoring |
| POST | `/api/monitor/stop` | Stop monitoring |
| GET | `/api/gmgn/trending` | Trending tokens |
| GET | `/api/gmgn/signals` | Smart money signals |

## Tech Stack

- **Backend:** Node.js, Express, WebSocket
- **Database:** SQLite (better-sqlite3)
- **Data:** GMGN OpenAPI
- **Frontend:** Vanilla HTML/CSS/JS
