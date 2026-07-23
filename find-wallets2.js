require('dotenv').config();
const axios = require('axios');

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS = `https://api.helius.xyz/v0`;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get recent trades on a token
async function getTokenTrades(mint, limit = 50) {
  try {
    const url = `${HELIUS}/addresses/${mint}/transactions?api-key=${HELIUS_KEY}&limit=${limit}`;
    const resp = await axios.get(url, { timeout: 15000 });
    return (resp.data || []).filter(tx => tx.type === 'SWAP');
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    return [];
  }
}

// Analyze a wallet's profitability across multiple memecoins
async function analyzeWalletProfitability(address) {
  try {
    const url = `${HELIUS}/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=30`;
    const resp = await axios.get(url, { timeout: 15000 });
    const txns = (resp.data || []).filter(tx => tx.type === 'SWAP');
    
    let totalBought = 0;
    let totalSold = 0;
    let swapCount = txns.length;
    let tokensTraded = new Set();
    
    for (const tx of txns) {
      const solSpent = (tx.nativeTransfers || [])
        .filter(t => t.fromUserAccount === address)
        .reduce((sum, t) => sum + t.amount, 0) / 1e9;
      const solReceived = (tx.nativeTransfers || [])
        .filter(t => t.toUserAccount === address)
        .reduce((sum, t) => sum + t.amount, 0) / 1e9;
      
      totalBought += solSpent;
      totalSold += solReceived;
      
      for (const tt of (tx.tokenTransfers || [])) {
        if (tt.toUserAccount === address || tt.fromUserAccount === address) {
          tokensTraded.add(tt.mint);
        }
      }
    }
    
    const pnl = totalSold - totalBought;
    const winRate = swapCount > 0 ? ((pnl > 0 ? 1 : 0) * 100) : 0;
    
    return {
      address,
      swapCount,
      tokensTraded: tokensTraded.size,
      totalBought: totalBought.toFixed(2),
      totalSold: totalSold.toFixed(2),
      pnl: pnl.toFixed(2),
      volume: (totalBought + totalSold).toFixed(2),
    };
  } catch (e) {
    return null;
  }
}

// Main: Find wallets that bought memecoins early
async function main() {
  console.log('🔍 Finding profitable memecoin wallets on Solana...\n');
  
  // Tokens that had big pumps recently
  const hotTokens = [
    { symbol: 'TRUMP', mint: '6p6xgHyF7AeE6TZkSmFskoR36phN2Rr6H8J2jd8j29s2' },
    { symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
    { symbol: 'PNUT', mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump' },
    { symbol: 'GOAT', mint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tqWJCnC29B29' },
    { symbol: 'GIGA', mint: '31NF576w2J4jGPKBy8LhGiWvK7PY8qgUMwfCGVAlpump' },
  ];
  
  const walletActivity = new Map(); // address -> { buys, sells, tokens }
  
  for (const token of hotTokens) {
    console.log(`📊 Scanning ${token.symbol} trades...`);
    const trades = await getTokenTrades(token.mint, 30);
    console.log(`   Found ${trades.length} swaps`);
    
    for (const tx of trades) {
      // Find the wallet that initiated the swap
      const signer = tx.feePayer || (tx.accountData || []).find(a => a.nativeBalanceChange < 0)?.account;
      if (!signer) continue;
      
      // Check if they received tokens (buy) or sent tokens (sell)
      const tokenIn = (tx.tokenTransfers || []).find(t => t.toUserAccount === signer);
      const tokenOut = (tx.tokenTransfers || []).find(t => t.fromUserAccount === signer);
      
      const existing = walletActivity.get(signer) || { buys: 0, sells: 0, tokens: new Set() };
      
      if (tokenIn) {
        existing.buys++;
        existing.tokens.add(token.symbol);
      }
      if (tokenOut) {
        existing.sells++;
      }
      
      walletActivity.set(signer, existing);
    }
    
    await sleep(500);
  }
  
  // Filter: must have bought multiple tokens (smart diversification)
  const candidates = [...walletActivity.entries()]
    .filter(([_, v]) => v.tokens.size >= 2 || (v.buys + v.sells) >= 3)
    .sort((a, b) => (b[1].buys + b[1].sells) - (a[1].buys + a[1].sells))
    .slice(0, 25);
  
  console.log(`\n🎯 Analyzing ${candidates.length} active traders...\n`);
  
  const results = [];
  for (const [address, activity] of candidates) {
    process.stdout.write(`  ${address.slice(0, 8)}...`);
    const analysis = await analyzeWalletProfitability(address);
    
    if (analysis && analysis.swapCount >= 3) {
      results.push({
        ...analysis,
        memecoinsFound: [...activity.tokens],
        buyCount: activity.buys,
        sellCount: activity.sells,
      });
      const pnlSign = parseFloat(analysis.pnl) >= 0 ? '+' : '';
      console.log(` ✅ ${analysis.swapCount} swaps | PnL: ${pnlSign}${analysis.pnl} SOL | ${analysis.tokensTraded} tokens`);
    } else {
      console.log(` ❌ skipped`);
    }
    
    await sleep(300);
  }
  
  // Sort by PnL
  results.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🏆 TOP PROFITABLE WALLETS: ${results.length}`);
  console.log(`${'='.repeat(80)}\n`);
  
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const emoji = parseFloat(r.pnl) >= 0 ? '💰' : '📉';
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   ${emoji} PnL: ${r.pnl} SOL | Volume: ${r.volume} SOL | Swaps: ${r.swapCount}`);
    console.log(`   Tokens: ${r.memecoinsFound.join(', ')}`);
    console.log('');
  }
  
  // JSON output
  console.log('--- WALLET JSON ---');
  console.log(JSON.stringify(results.map(r => ({
    address: r.address,
    label: `PnL: ${r.pnl} SOL | ${r.swapCount} swaps | ${r.memecoinsFound.join(', ')}`,
    category: parseFloat(r.pnl) > 0 ? 'profitable' : 'active',
  })), null, 2));
}

main().catch(console.error);
