require('dotenv').config();
const axios = require('axios');

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS = `https://api.helius.xyz/v0`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get recent swap traders on a token
async function getTokenTraders(mint) {
  try {
    const url = `${HELIUS}/addresses/${mint}/transactions?api-key=${HELIUS_KEY}&limit=25`;
    const resp = await axios.get(url, { timeout: 15000 });
    const txns = (resp.data || []).filter(tx => tx.type === 'SWAP');
    const traders = new Set();
    for (const tx of txns) {
      if (tx.feePayer) traders.add(tx.feePayer);
    }
    return [...traders];
  } catch (e) {
    return [];
  }
}

// Get wallet's recent trades
async function getWalletSwaps(address) {
  try {
    const url = `${HELIUS}/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=15`;
    const resp = await axios.get(url, { timeout: 15000 });
    return (resp.data || []).filter(tx => tx.type === 'SWAP');
  } catch (e) {
    return [];
  }
}

async function main() {
  console.log('🔍 Finding active memecoin traders on Solana...\n');

  const tokens = [
    { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
    { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
    { symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
    { symbol: 'PNUT', mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump' },
  ];

  const walletTrades = new Map(); // address -> { tokens, swapCount, solIn, solOut }

  for (const token of tokens) {
    console.log(`📊 Scanning ${token.symbol}...`);
    const traders = await getTokenTraders(token.mint);
    console.log(`   ${traders.length} traders found`);

    for (const addr of traders) {
      const existing = walletTrades.get(addr) || { tokens: new Set(), swaps: 0, solIn: 0, solOut: 0 };
      existing.tokens.add(token.symbol);
      walletTrades.set(addr, existing);
    }
    await sleep(500);
  }

  // Get wallets that appear in multiple tokens OR have high activity
  const candidates = [...walletTrades.entries()]
    .sort((a, b) => b[1].tokens.size - a[1].tokens.size)
    .slice(0, 20);

  console.log(`\n🎯 Analyzing ${candidates.length} wallets...\n`);

  const results = [];
  for (const [address, info] of candidates) {
    process.stdout.write(`  ${address.slice(0, 8)}...`);
    const swaps = await getWalletSwaps(address);

    let solIn = 0, solOut = 0;
    const tokensTraded = new Set();
    for (const tx of swaps) {
      const spent = (tx.nativeTransfers || [])
        .filter(t => t.fromUserAccount === address)
        .reduce((s, t) => s + t.amount, 0) / 1e9;
      const received = (tx.nativeTransfers || [])
        .filter(t => t.toUserAccount === address)
        .reduce((s, t) => s + t.amount, 0) / 1e9;
      solIn += spent;
      solOut += received;
      for (const tt of (tx.tokenTransfers || [])) {
        if (tt.toUserAccount === address || tt.fromUserAccount === address) {
          tokensTraded.add(tt.mint);
        }
      }
    }

    const pnl = solOut - solIn;
    results.push({
      address,
      swaps: swaps.length,
      tokensTraded: tokensTraded.size,
      solIn: solIn.toFixed(4),
      solOut: solOut.toFixed(4),
      pnl: pnl.toFixed(4),
      memecoins: [...info.tokens],
    });

    const sign = pnl >= 0 ? '+' : '';
    console.log(` ${swaps.length} swaps | ${tokensTraded.size} tokens | PnL: ${sign}${pnl.toFixed(4)} SOL`);
    await sleep(300);
  }

  // Sort by activity
  results.sort((a, b) => b.swaps - a.swaps);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`🏆 RESULTS: ${results.length} wallets`);
  console.log(`${'='.repeat(80)}\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   Swaps: ${r.swaps} | Tokens: ${r.tokensTraded} | PnL: ${r.pnl} SOL`);
    console.log(`   Memes: ${r.memecoins.join(', ')}`);
    console.log('');
  }

  // JSON for import
  console.log('--- JSON ---');
  console.log(JSON.stringify(results.map(r => ({
    address: r.address,
    label: `${r.swaps} swaps, ${r.memecoins.join('/')}`,
    category: 'active-trader',
  })), null, 2));
}

main().catch(console.error);
