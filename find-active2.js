require('dotenv').config();
const axios = require('axios');

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS = `https://api.helius.xyz/v0`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkWallet(address) {
  try {
    const url = `${HELIUS}/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=20`;
    const resp = await axios.get(url, { timeout: 15000 });
    const txns = resp.data || [];
    const swaps = txns.filter(tx => tx.type === 'SWAP');
    
    let solVolume = 0;
    const tokens = new Set();
    let buys = 0;
    let sells = 0;
    
    for (const tx of swaps) {
      const solSpent = (tx.nativeTransfers || [])
        .filter(t => t.fromUserAccount === address)
        .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
      const solReceived = (tx.nativeTransfers || [])
        .filter(t => t.toUserAccount === address)
        .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
      
      solVolume += solSpent + solReceived;
      
      if (solSpent > 0) buys++;
      if (solReceived > 0) sells++;
      
      for (const tt of (tx.tokenTransfers || [])) {
        if (tt.toUserAccount === address || tt.fromUserAccount === address) {
          tokens.add(tt.mint);
        }
      }
    }
    
    // Time span in hours
    const timestamps = txns.map(tx => tx.timestamp || 0).filter(t => t > 0);
    const spanHours = timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 3600 : 0;
    
    return {
      address,
      swaps: swaps.length,
      buys,
      sells,
      tokens: tokens.size,
      volume: solVolume,
      spanHours,
    };
  } catch (e) {
    return { address, error: e.message };
  }
}

// All candidate wallets
const WALLETS = [
  // Nansen verified (proven profitable)
  { addr: '4EtAJ1p8RjqccEVhEhaYnEgQ6kA4JHR8oYqyLFwARUj6', name: 'Trump Whale ($44M)' },
  { addr: 'EdCNh8EzETJLFphW8yvdY7rDd8zBiyweiz8DU5gUUUka', name: 'cifwifhatday ($23.4M)' },
  { addr: '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd', name: 'traderpow ($14.8M)' },
  { addr: '8mZYBV8aPvPCo34CyCmt6fWkZRFviAUoBZr1Bn993gro', name: 'popchad ($7.2M)' },
  { addr: '5CP6zv8a17mz91v6rMruVH6ziC5qAL8GFaJzwrX9Fvup', name: 'naseem ($8M)' },
  { addr: 'H2ikJvq8or5MyjvFowD7CDY6fG3Sc2yi4mxTnfovXy3K', name: 'shatter ($35M)' },
  { addr: '2h7s3FpSvc6v2oHke6Uqg191B5fPCeFTmMGnh5oPWhX7', name: 'tonka ($21.8M)' },
  { addr: 'HWdeCUjBvPP1HJ5oCJt7aNsvMWpWoDgiejUWvfFX6T7R', name: 'Multi-Meme Whale ($9.65M)' },
  { addr: '4DPxYoJ5DgjvXPUtZdT3CYUZ3EEbSPj4zMNEVFJTd1Ts', name: 'Sigil Fund ($6M)' },
  { addr: 'Hwz4BDgtDRDBTScpEKDawshdKatZJh6z1SJYmRUxTxKE', name: 'Anon High-Perf' },
  { addr: 'fwHknyxZTgFGytVz9VPrvWqipW2V4L4D99gEb831t81', name: 'AI16Z Top 100 ($1.53M)' },
  // Auto-discovered active traders
  { addr: 'Hasda78TSaT9bjiPxDBvP4GpohFpP3TDTaJEcCYK5kyN', name: 'FARTCOIN Trader' },
  { addr: '3s9PL6xyAvBsAchZyTsTbgoedhX6zxC6keRLLanGbjL1', name: 'BONK Trader' },
  { addr: 'Fwin1gWxbFAyb1MNPqwETyb4g8oaA2Hdg1ypyxSUsyjE', name: 'BONK Active' },
  { addr: 'GoGoGo6N99mpyB7rfzhw2R4fXmaFctURXHaHMoGCyoLD', name: 'Multi-Meme Active' },
  { addr: '12ahuQxMSghrF86aZPW2wuipr5be2eYwAdtBfiusaQ94', name: 'POPCAT Trader' },
  { addr: '5ZGprBDnP2pWaYcbiAfN87UrZH3VihZo1aKSXXWskrZZ', name: 'High-Token Diversified' },
  { addr: '6iihNyNkEXknbzXw5VMhgFeBgk8LCpJfEbSHhgARzS8z', name: 'POPCAT Active' },
  { addr: 'EBAo2Q3MqFfwCxJ3ZDDi4mh6hR2Cc7tMbQkFj47uiMJS', name: 'Multi-Token Trader' },
  { addr: 'CgpYNooAjF226taRRLVuCx4r5RPzT7UqhQ5jFiVMWhUw', name: 'PNUT Trader' },
];

async function main() {
  console.log('🔍 Analyzing all wallets for best copy-trade candidates...\n');
  
  const results = [];
  
  for (const w of WALLETS) {
    process.stdout.write(`  ${w.name.padEnd(25)}`);
    const data = await checkWallet(w.addr);
    
    if (data.error) {
      console.log(` ❌ ${data.error}`);
    } else {
      // Score: weighted by volume, token diversity, and buy/sell balance
      const volumeScore = Math.min(data.volume, 100); // Cap at 100 SOL
      const diversityScore = data.tokens * 5;
      const activityScore = data.swaps * 2;
      const balanceScore = Math.min(data.buys, data.sells) * 3; // Balanced buy/sell = better
      
      const totalScore = volumeScore + diversityScore + activityScore + balanceScore;
      
      console.log(` ✅ ${data.swaps} swaps (${data.buys}B/${data.sells}S) | ${data.tokens} tokens | ${data.volume.toFixed(1)} SOL`);
      results.push({ ...data, name: w.name, score: totalScore });
    }
    
    await sleep(800);
  }
  
  // Sort by score (best combination of activity + volume + diversity)
  results.sort((a, b) => b.score - a.score);
  
  console.log(`\n${'='.repeat(80)}`);
  console.log('🏆 TOP 11 BEST COPY-TRADE WALLETS');
  console.log('   (ranked by: volume + token diversity + activity + buy/sell balance)');
  console.log(`${'='.repeat(80)}\n`);
  
  const top11 = results.slice(0, 11);
  
  for (let i = 0; i < top11.length; i++) {
    const r = top11[i];
    console.log(`${String(i+1).padStart(2)}. ${r.name}`);
    console.log(`    ${r.address}`);
    console.log(`    Swaps: ${r.swaps} (${r.buys} buys / ${r.sells} sells) | Tokens: ${r.tokens} | Volume: ${r.volume.toFixed(2)} SOL | Score: ${r.score.toFixed(0)}`);
    console.log('');
  }
  
  // Output for import
  console.log('--- WALLET LIST ---');
  console.log(JSON.stringify(top11.map(r => ({
    address: r.address,
    label: `⭐ ${r.name} — ${r.swaps} swaps, ${r.tokens} tokens, ${r.volume.toFixed(1)} SOL vol`,
    category: 'top-11',
  })), null, 2));
}

main().catch(console.error);
