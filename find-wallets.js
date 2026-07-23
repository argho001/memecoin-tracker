require('dotenv').config();
const axios = require('axios');

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS = `https://api.helius.xyz/v0`;

// Popular memecoins to scan for whale activity
const MEMECOINS = [
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'TRUMP', mint: '6p6xgHyF7AeE6TZkSmFskoR36phN2Rr6H8J2jd8j29s2' },
  { symbol: 'MEW', mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79yvzG49Td4Mbpump' },
  { symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
  { symbol: 'GIGA', mint: '31NF576w2J4jGPKBy8LhGiWvK7PY8qgUMwfCGVAlpump' },
  { symbol: 'PNUT', mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump' },
  { symbol: 'GOAT', mint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tqWJCnC29B29' },
  { symbol: 'MYRO', mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get recent transactions for a wallet
async function getWalletTxns(address, limit = 10) {
  try {
    const url = `${HELIUS}/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=${limit}`;
    const resp = await axios.get(url, { timeout: 15000 });
    return resp.data || [];
  } catch (e) {
    return [];
  }
}

// Check if a wallet has recent memecoin swap activity
async function analyzeWallet(address) {
  const txns = await getWalletTxns(address, 20);
  
  let swaps = 0;
  let memecoinSwaps = 0;
  let tokens = new Set();
  let totalSolVolume = 0;
  
  for (const tx of txns) {
    if (tx.type === 'SWAP') {
      swaps++;
      const solSpent = (tx.nativeTransfers || [])
        .filter(t => t.fromUserAccount === address)
        .reduce((sum, t) => sum + (t.amount || 0), 0);
      const solReceived = (tx.nativeTransfers || [])
        .filter(t => t.toUserAccount === address)
        .reduce((sum, t) => sum + (t.amount || 0), 0);
      totalSolVolume += (solSpent + solReceived) / 1e9;
      
      // Check if it's a memecoin
      const tokenTransfers = (tx.tokenTransfers || [])
        .filter(t => t.toUserAccount === address || t.fromUserAccount === address);
      for (const tt of tokenTransfers) {
        const isMemecoin = MEMECOINS.some(m => m.mint === tt.mint);
        if (isMemecoin) memecoinSwaps++;
        tokens.add(tt.mint);
      }
    }
  }
  
  return {
    address,
    swaps,
    memecoinSwaps,
    uniqueTokens: tokens.size,
    totalSolVolume: totalSolVolume.toFixed(2),
    recentTxCount: txns.length,
  };
}

// Get top holders of a token via Helius
async function getTopHolders(mint, limit = 20) {
  try {
    // Use Solana RPC via Helius
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
    const resp = await axios.post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenLargestAccounts',
      params: [mint],
    }, { timeout: 15000 });
    
    const accounts = resp.data?.result?.value || [];
    const addresses = [];
    
    for (const acc of accounts.slice(0, limit)) {
      // Get the owner of each token account
      try {
        const ownerResp = await axios.post(url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [acc.address, { encoding: 'jsonParsed' }],
        }, { timeout: 10000 });
        
        const owner = ownerResp.data?.result?.value?.data?.parsed?.info?.owner;
        if (owner) {
          addresses.push({
            owner,
            balance: parseFloat(acc.uiAmountString || '0'),
          });
        }
      } catch (e) {
        // skip
      }
      await sleep(100);
    }
    
    return addresses;
  } catch (e) {
    console.error(`  Error getting holders for ${mint}: ${e.message}`);
    return [];
  }
}

// Filter out known exchange/program wallets
const EXCHANGES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Jupiter
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
]);

async function main() {
  console.log('🔍 Scanning Solana memecoins for smart money wallets...\n');
  
  const walletScores = new Map(); // address -> {score, tokens, volume}
  
  // Step 1: Get top holders of each memecoin
  for (const coin of MEMECOINS.slice(0, 6)) { // Scan top 6 coins to stay within rate limits
    console.log(`📊 Scanning ${coin.symbol} top holders...`);
    const holders = await getTopHolders(coin.mint, 15);
    console.log(`   Found ${holders.length} holders`);
    
    for (const h of holders) {
      if (EXCHANGES.has(h.owner)) continue;
      if (h.balance < 1000) continue; // Skip dust holders
      
      const existing = walletScores.get(h.owner) || { tokens: 0, volume: 0, coins: [] };
      existing.tokens++;
      existing.volume += h.balance;
      if (!existing.coins.includes(coin.symbol)) existing.coins.push(coin.symbol);
      walletScores.set(h.owner, existing);
    }
    
    await sleep(500);
  }
  
  console.log(`\n📋 Found ${walletScores.size} unique wallet candidates`);
  
  // Step 2: Sort by number of memecoins held (holds multiple = smarter)
  const candidates = [...walletScores.entries()]
    .filter(([_, v]) => v.tokens >= 2) // Must hold at least 2 memecoins
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 30);
  
  console.log(`🎯 Analyzing top ${candidates.length} multi-token holders...\n`);
  
  // Step 3: Analyze each wallet's trading activity
  const results = [];
  for (const [address, info] of candidates) {
    process.stdout.write(`  Analyzing ${address.slice(0, 8)}...`);
    const analysis = await analyzeWallet(address);
    
    if (analysis.swaps >= 3) { // Must have recent swap activity
      results.push({
        ...analysis,
        memecoinsHeld: info.coins,
        holderTokens: info.tokens,
      });
      console.log(` ✅ ${analysis.swaps} swaps, ${analysis.memecoinSwaps} meme swaps, ${analysis.uniqueTokens} tokens`);
    } else {
      console.log(` ❌ low activity`);
    }
    
    await sleep(300);
  }
  
  // Step 4: Sort by activity and show results
  results.sort((a, b) => b.swaps - a.swaps);
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🏆 TOP SMART MONEY WALLETS FOUND: ${results.length}`);
  console.log(`${'='.repeat(80)}\n`);
  
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   Swaps: ${r.swaps} | Meme Swaps: ${r.memecoinSwaps} | Tokens: ${r.uniqueTokens} | SOL Vol: ${r.totalSolVolume}`);
    console.log(`   Holds: ${r.memecoinsHeld.join(', ')}`);
    console.log('');
  }
  
  // Output JSON for easy import
  console.log('\n--- JSON (copy below) ---');
  console.log(JSON.stringify(results.map(r => ({
    address: r.address,
    label: `Auto-found: ${r.memecoinsHeld.join(', ')} holder, ${r.swaps} swaps`,
    category: 'auto-discovered',
  })), null, 2));
}

main().catch(console.error);
