/**
 * Jito MEV Protection Module
 * 
 * Sends transactions as Jito bundles to prevent front-running.
 * Bundles go directly to Jito validators, bypassing the public mempool.
 */

const { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

// Jito Block Engine endpoints
const JITO_BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

// Jito tip accounts (randomly select one per bundle)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiLMiXRSE',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLbTfaQ9RnhRat44ep',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiDuNwLVS2B95aJGjKGamZiHmXRiCvGMZaJ',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const SOL_MINT = 'So11111111111111111111111111111111111111112';

class JitoProtector {
  constructor(rpcUrl, privateKey) {
    this.connection = new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    
    if (privateKey) {
      this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    }
    
    this.tipAmountLamports = 10000; // 0.00001 SOL default tip
    this.bundleEndpoint = JITO_BLOCK_ENGINES[0];
  }

  /**
   * Set tip amount in SOL
   */
  setTip(solAmount) {
    this.tipAmountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  }

  /**
   * Send a transaction as a Jito bundle
   * Returns: { success, signature, bundleId, error }
   */
  async sendBundle(transactions) {
    const bundle = transactions.map(tx => {
      if (tx instanceof Transaction) {
        return bs58.encode(tx.serialize());
      }
      return tx; // Already serialized
    });

    // Try each block engine
    for (const endpoint of JITO_BLOCK_ENGINES) {
      try {
        const response = await fetch(`${endpoint}/api/v1/bundles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [bundle],
          }),
        });

        const data = await response.json();
        
        if (data.result) {
          return {
            success: true,
            bundleId: data.result,
            endpoint: endpoint,
          };
        }

        if (data.error) {
          console.log(`Jito ${endpoint}: ${data.error.message}`);
          continue;
        }
      } catch (e) {
        console.log(`Jito ${endpoint} failed: ${e.message}`);
        continue;
      }
    }

    return { success: false, error: 'All Jito endpoints failed' };
  }

  /**
   * Check bundle status
   */
  async getBundleStatus(bundleId) {
    for (const endpoint of JITO_BLOCK_ENGINES) {
      try {
        const response = await fetch(`${endpoint}/api/v1/bundles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        const data = await response.json();
        if (data.result?.value?.[0]) {
          return data.result.value[0];
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  /**
   * Create a tip transaction to Jito validator
   */
  createTipTransaction(payerPubkey) {
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    
    return SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: tipAccount,
      lamports: this.tipAmountLamports,
    });
  }

  /**
   * Build a swap transaction with Jito tip
   * This is a template - actual swap logic depends on DEX
   */
  async buildSwapWithTip({
    payer,
    inputMint,
    outputMint,
    amountLamports,
    slippageBps = 50, // 0.5% default slippage
    swapInstruction,
  }) {
    const transaction = new Transaction();

    // Add the swap instruction
    if (swapInstruction) {
      transaction.add(swapInstruction);
    }

    // Add Jito tip
    transaction.add(this.createTipTransaction(payer.publicKey));

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = payer.publicKey;

    // Sign
    transaction.sign(payer);

    return transaction;
  }

  /**
   * Get Jupiter swap instruction with MEV protection
   * Uses Jupiter API to get the best route, then wraps in Jito bundle
   */
  async getJupiterSwapWithJito({
    payer,
    inputMint,
    outputMint,
    amountLamports,
    slippageBps = 50,
  }) {
    try {
      // Get quote from Jupiter
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
      const quoteResp = await fetch(quoteUrl);
      const quote = await quoteResp.json();

      if (!quote.routePlan) {
        return { success: false, error: 'No route found' };
      }

      // Get swap transaction from Jupiter
      const swapResp = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: payer.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 0, // We use Jito tip instead
        }),
      });

      const swapData = await swapResp.json();

      if (!swapData.swapTransaction) {
        return { success: false, error: 'Failed to get swap transaction' };
      }

      // Deserialize the transaction
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const transaction = Transaction.from(swapTransactionBuf);

      // Add Jito tip instruction
      transaction.add(this.createTipTransaction(payer.publicKey));

      // Re-sign with our keypair
      transaction.sign(payer);

      // Send as Jito bundle
      const result = await this.sendBundle([transaction]);

      return {
        success: result.success,
        bundleId: result.bundleId,
        inputMint,
        outputMint,
        amount: amountLamports,
        quote: quote,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = { JitoProtector, JITO_BLOCK_ENGINES, JITO_TIP_ACCOUNTS };
