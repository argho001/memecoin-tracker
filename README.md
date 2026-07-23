# Memecoin Tracker — GMGN Edition

Real-time Solana memecoin copy-trading bot. Tracks whale wallets via GMGN API, detects BUY/SELL trades across all DEXes (Pump.fun, Raydium, Jupiter, etc.), and paper trades to measure profitability.

## Live Demo

**https://memecoin-tracker-production-8a70.up.railway.app**

## Features

- **Real-time wallet monitoring** — polls GMGN API every 3 seconds
- **Multi-key rotation** — uses 3 API keys to maximize rate limits
- **Built-in rate limiter** — leaky bucket algorithm, stays within GMGN limits
- **Auto-detect BUY/SELL** on Pump.fun, Raydium, Jupiter, Orca, etc.
- **Paper trading** — tracks entry/exit prices, calculates P&L per trade
- **Live dashboard** — WebSocket updates, no page refresh needed
- **Wallet leaderboard** — ranks tracked wallets by win rate and P&L
- **Auto-seed wallets** —30 pre-loaded smart money wallets on startup
- **Synced UI** — monitor state persists across page reloads

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
4. Add Environment Variable:
   - `GMGN_API_KEYS` = your API keys (comma-separated)
5. Deploy!

The app auto-seeds 30 smart money wallets and starts monitoring on first boot.

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
| GET | `/api/monitor/status` | Monitor status |
| GET | `/api/gmgn/trending` | Trending tokens |
| GET | `/api/gmgn/signals` | Smart money signals |
| POST | `/api/demo/seed` | Seed demo data |

## How It Works

1. **Add wallets** — track whale addresses via dashboard or API
2. **Monitor polls** — checks each wallet's recent activity every 3s
3. **Detect trades** — GMGN returns buy/sell events with token, amount, DEX
4. **Paper trade** — simulates copying the trade at market price
5. **Calculate P&L** — tracks entry, exit, profit/loss per position
6. **Dashboard updates** — WebSocket pushes new trades in real-time

## Rate Limiting

GMGN API uses a leaky bucket: capacity=20, rate=20 tokens/sec.

| Endpoint | Weight | Max per burst |
|----------|--------|---------------|
| `wallet_activity` | 3 | ~6 calls |
| `wallet_stats` | 3 | ~6 calls |
| `market/rank` | 1 | ~20 calls |

With 3 API keys rotating: ~18 calls per burst. Full cycle through 30 wallets: ~15 seconds.

## Tech Stack

- **Backend:** Node.js, Express, WebSocket
- **Database:** SQLite (better-sqlite3)
- **Data:** GMGN OpenAPI
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Hosting:** Railway (Dockerfile with Node 22)
