# Memecoin Paper Trading Dashboard

Track whale wallets on Solana, detect their memecoin trades in real-time, and paper trade to see if copying them would be profitable.

## Features

- **Real-time wallet monitoring** via Helius Enhanced API
- **Auto-detect BUY/SELL** swaps on Raydium, Jupiter, etc.
- **Paper trading** — tracks entry/exit prices, calculates P&L
- **Live dashboard** with WebSocket updates
- **Wallet leaderboard** — see which tracked wallets are actually profitable
- **Demo mode** — seed fake data to explore without an API key

## Quick Start

```bash
# 1. Install
npm install

# 2. Get a free Helius API key
#    https://helius.dev (free tier: 100K credits/day)

# 3. Set your API key
echo "HELIUS_API_KEY=your_key_here" > .env

# 4. Run
node server.js

# 5. Open dashboard
#    http://localhost:3000
```

## Without API Key (Demo Mode)

```bash
node server.js
# Open http://localhost:3000
# Click "Seed Demo" to load sample data
```

## How It Works

1. **Add wallets** to track via the dashboard
2. **Start the monitor** — polls wallets every 5 seconds
3. When a tracked wallet **buys** a token → recorded as BUY signal
4. When they **sell** → recorded as SELL signal, P&L calculated
5. Dashboard shows all trades, positions, and performance stats

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/wallets` | List tracked wallets |
| POST | `/api/wallets` | Add wallet `{address, label}` |
| DELETE | `/api/wallets/:id` | Remove wallet |
| GET | `/api/trades?limit=50` | Get trade history |
| GET | `/api/positions?status=OPEN` | Get paper positions |
| GET | `/api/stats` | Performance stats |
| POST | `/api/monitor/start` | Start monitoring |
| POST | `/api/monitor/stop` | Stop monitoring |
| POST | `/api/demo/seed` | Seed demo data |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HELIUS_API_KEY` | — | Helius API key (required for live monitoring) |
| `PORT` | 3000 | Server port |
| `POLL_INTERVAL_MS` | 5000 | How often to check wallets (ms) |

## Tech Stack

- **Backend:** Node.js, Express, WebSocket
- **Database:** SQLite (via better-sqlite3)
- **Data:** Helius Enhanced Transactions API
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
