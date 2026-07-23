require('dotenv').config();
const axios = require('axios');

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS = `https://api.helius.xyz/v0`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Check how active a wallet is (recent swap count)
async function checkActivity(address) {
  try {
    const url = `${HELIUS}/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=20`;
    const resp = await axios.get(url, { timeout: 15000 });
    const txns = resp.data || [];
    const swaps = txns.filter(tx => tx.type === 'SWAP');
    
    // Calculate time span
    const timestamps = txns.map(tx => tx.timestamp || 0).filter(t => t > 0);
    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);
    const spanHours = (newest - oldest) / 3600;
    
    // Count unique tokens traded
    const tokens = new Set();
    let totalSolVolume = 0;
    
    for (const tx of swaps) {
      const solSpent = (tx.nativeTransfers || [])
        .filter(t => t.fromUserAccount === address)
        .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
      const solReceived = (tx.nativeTransfers || [])
        .filter(t => t.toUserAccount === address)
        .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
      totalSolVolume += solSpent + solReceived;
      
      for (const tt of (tx.tokenTransfers || [])) {
        if (tt.toUserAccount === address || tt.fromUserAccount === address) {
          tokens.add(tt.mint);
        }
      }
    }
    
    return {
      address,
      totalTxns: txns.length,
      swapCount: swaps.length,
      uniqueTokens: tokens.size,
      volume: totalSolVolume.toFixed(2),
      spanHours: spanHours.toFixed(1),
      swapsPerDay: spanHours > 0 ? ((swaps.length / spanHours) * 24).toFixed(1) : 'N/A',
    };
  } catch (e) {
    return { address, error: e.message };
  }
}

// Known wallets to test
const WALLETS = [
  // Nansen verified
  '4EtAJ1p8RjqccEVhEhaYnEgQ6kA4JHR8oYqyLFwARUj6', // Trump Whale
  'EdCNh8EzETJLFphW8yvdY7rDd8zBiyweiz8DU5gUUUka', // cifwifhatday
  '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd', // traderpow
  '8mZYBV8aPvPCo34CyCmt6fWkZRFviAUoBZr1Bn993gro', // popchad
  '5CP6zv8a17mz91v6rMruVH6ziC5qAL8GFaJzwrX9Fvup', // naseem
  'H2ikJvq8or5MyjvFowD7CDY6fG3Sc2yi4mxTnfovXy3K', // shatter
  '2h7s3FpSvc6v2oHke6Uqg191B5fPCeFTmMGnh5oPWhX7', // tonka
  'HWdeCUjBvPP1HJ5oCJt7aNsvMWpWoDgiejUWvfFX6T7R', // Multi-Meme Whale
  '4DPxYoJ5DgjvXPUtZdT3CYUZ3EEbSPj4zMNEVFJTd1Ts', // Sigil Fund
  'Hwz4BDgtDRDBTScpEKDawshdKatZJh6z1SJYmRUxTxKE', // Anon High-Perf
  'fwHknyxZTgFGytVz9VPrvWqipW2V4L4D99gEb831t81', // AI16Z Top 100
  // Auto-discovered
  'Fwin1gWxbFAyb1MNPqwETyb4g8oaA2Hdg1ypyxSUsyjE',
  'EBAo2Q3MqFfwCxJ3ZDDi4mh6hR2Cc7tMbQkFj47uiMJS',
  '6iihNyNkEXknbzXw5VMhgFeBgk8LCpJfEbSHhgARzS8z',
  'CgpYNooAjF226taRRLVuCx4r5RPzT7UqhQ5jFiVMWhUw',
  '3s9PL6xyAvBsAchZyTsTbgoedhX6zxC6keRLLanGbjL1',
  '12ahuQxMSghrF86aZPW2wuipr5be2eYwAdtBfiusaQ94',
  'Hasda78TSaT9bjiPxDBvP4GpohFpP3TDTaJEcCYK5kyN',
  'GoGoGo6N99mpyB7rfzhw2R4fXmaFctURXHaHMoGCyoLD',
  '5ZGprBDnP2pWaYcbiAfN87UrZH3VihZo1aKSXXWskrZZ',
];

async function main() {
  console.log('🔍 Checking activity of all wallets...\n');
  
  const results = [];
  
  for (const addr of WALLETS) {
    process.stdout.write(`  ${addr.slice(0, 8)}...`);
    const activity = await checkActivity(addr);
    
    if (activity.error) {
      console.log(` ❌ ${activity.error}`);
    } else {
      console.log(` ✅ ${activity.swapCount} swaps | ${activity.uniqueTokens} tokens | ${activity.swapsPerDay}/day | Vol: ${activity.volume} SOL`);
      results.push(activity);
    }
    
    await sleep(800); // Respect rate limits
  }
  
  // Sort by swap frequency (swaps per day)
  results.sort((a, b) => parseFloat(b.swapsPerDay) - parseFloat(a.swapsPerDay));
  
  console.log(`\n${'='.repeat(80)}`);
  console.log('🏆 TOP 11 MOST ACTIVE WALLETS (sorted by trades/day)');
  console.log(`${'='.repeat(80)}\n`);
  
  const top11 = results.slice(0, 11);
  
  for (let i = 0; i < top11.length; i++) {
    const r = top11[i];
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   Swaps: ${r.swapCount} | Tokens: ${r.uniqueTokens} | ${r.swapsPerDay} swaps/day | Vol: ${r.volume} SOL`);
    console.log('');
  }
  
  // JSON for easy import
  console.log('--- TOP 11 JSON ---');
  console.log(JSON.stringify(top11.map(r => ({
    address: r.address,
    label: `${r.swapsPerDay}/day, ${r.swapCount} swaps, ${r.uniqueTokens} tokens`,
    category: 'active-trader',
  })), null, 2));
}

main().catch(console.error);
