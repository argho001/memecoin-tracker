/**
 * Live Trade Executor
 * 
 * Executes copy-trades with Jito MEV protection.
 * Paper trading mode: logs trades without executing.
 * Live mode: sends real transactions via Jito bundles.
 */

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const { JitoProtector } = require('./jito');
const db = require('./db');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

class TradeExecutor {
  constructor(config = {}) {
    this.mode = config.mode || 'paper'; // 'paper' or 'live'
    this.rpcUrl = config.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    // Live trading config
    this.wallet = null;
    this.jito = null;
    this.maxPositionSol = config.maxPositionSol || 1.0;
    this.slippageBps = config.slippageBps || 100; // 1%
    this.jitoTipSol = config.jitoTipSol || 0.001;
    
    // Risk management
    this.stopLossPercent = config.stopLossPercent || 50; // -50%
    this.takeProfitPercent = config.takeProfitPercent || 500; // +500%
    
    if (config.privateKey) {
      this.wallet = Keypair.fromSecretKey(bs58.decode(config.privateKey));
      this.jito = new JitoProtector(this.rpcUrl, config.privateKey);
      this.jito.setTip(this.jitoTipSol);
    }
  }

  /**
   * Process a detected trade from a tracked wallet
   */
  async processTrade(trade) {
    if (trade.type === 'BUY') {
      return await this.handleBuy(trade);
    } else if (trade.type === 'SELL') {
      return await this.handleSell(trade);
    }
    return null;
  }

  /**
   * Handle a BUY signal
   */
  async handleBuy(trade) {
    console.log(`📈 BUY signal: ${trade.tokenSymbol} from ${trade.walletAddress.slice(0, 8)}...`);

    if (this.mode === 'paper') {
      return this.paperBuy(trade);
    }

    // Live mode
    if (!this.wallet || !this.jito) {
      console.log('⚠️  Live mode: wallet not configured');
      return this.paperBuy(trade); // Fallback to paper
    }

    try {
      // Calculate position size (match whale's proportional size or use fixed)
      const amountSol = Math.min(trade.amountSol, this.maxPositionSol);
      const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

      console.log(`🔄 Executing buy: ${amountSol} SOL → ${trade.tokenSymbol}`);
      console.log(`   Using Jito bundles for MEV protection...`);

      // Execute via Jupiter + Jito
      const result = await this.jito.getJupiterSwapWithJito({
        payer: this.wallet,
        inputMint: SOL_MINT,
        outputMint: trade.tokenAddress,
        amountLamports: amountLamports,
        slippageBps: this.slippageBps,
      });

      if (result.success) {
        console.log(`✅ Buy executed! Bundle ID: ${result.bundleId}`);
        
        // Save to database
        this.saveTrade(trade, 'BUY', amountSol, result.bundleId);
        
        return {
          success: true,
          action: 'BUY',
          token: trade.tokenSymbol,
          amount: amountSol,
          bundleId: result.bundleId,
          mevProtected: true,
        };
      } else {
        console.log(`❌ Buy failed: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (e) {
      console.log(`❌ Buy error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Handle a SELL signal
   */
  async handleSell(trade) {
    console.log(`📉 SELL signal: ${trade.tokenSymbol} from ${trade.walletAddress.slice(0, 8)}...`);

    if (this.mode === 'paper') {
      return this.paperSell(trade);
    }

    // Live mode
    if (!this.wallet || !this.jito) {
      console.log('⚠️  Live mode: wallet not configured');
      return this.paperSell(trade);
    }

    try {
      // Find our open position for this token
      const position = db.prepare(`
        SELECT * FROM paper_positions 
        WHERE wallet_address = ? AND token_address = ? AND status = 'OPEN'
        ORDER BY buy_time DESC LIMIT 1
      `).get(this.wallet.publicKey.toString(), trade.tokenAddress);

      if (!position) {
        console.log('⚠️  No open position found for', trade.tokenSymbol);
        return { success: false, error: 'No open position' };
      }

      // Get token balance
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(trade.tokenAddress) }
      );

      if (tokenAccounts.value.length === 0) {
        console.log('⚠️  No token balance found');
        return { success: false, error: 'No token balance' };
      }

      const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
      const decimals = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals;

      console.log(`🔄 Executing sell: ${tokenBalance / Math.pow(10, decimals)} ${trade.tokenSymbol}`);
      console.log(`   Using Jito bundles for MEV protection...`);

      // Execute via Jupiter + Jito
      const result = await this.jito.getJupiterSwapWithJito({
        payer: this.wallet,
        inputMint: trade.tokenAddress,
        outputMint: SOL_MINT,
        amountLamports: parseInt(tokenBalance),
        slippageBps: this.slippageBps,
      });

      if (result.success) {
        console.log(`✅ Sell executed! Bundle ID: ${result.bundleId}`);
        
        // Calculate P&L
        const sellValueSol = result.quote?.outAmount ? parseInt(result.quote.outAmount) / LAMPORTS_PER_SOL : 0;
        const pnlSol = sellValueSol - position.buy_amount_sol;
        const pnlPercent = position.buy_price_sol > 0 ? ((sellValueSol / position.buy_amount_sol) - 1) * 100 : 0;

        // Update position
        db.prepare(`
          UPDATE paper_positions 
          SET sell_price_sol = ?, sell_amount_sol = ?, sell_time = ?, 
              pnl_sol = ?, pnl_percent = ?, status = 'CLOSED'
          WHERE id = ?
        `).run(
          sellValueSol / (tokenBalance / Math.pow(10, decimals)),
          sellValueSol,
          new Date().toISOString(),
          pnlSol,
          pnlPercent,
          position.id
        );

        const emoji = pnlSol >= 0 ? '💰' : '📉';
        console.log(`${emoji} P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);

        return {
          success: true,
          action: 'SELL',
          token: trade.tokenSymbol,
          pnl: pnlSol,
          pnlPercent: pnlPercent,
          bundleId: result.bundleId,
          mevProtected: true,
        };
      } else {
        console.log(`❌ Sell failed: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (e) {
      console.log(`❌ Sell error: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Paper buy (no real execution)
   */
  paperBuy(trade) {
    const amountSol = trade.amountSol;
    
    db.prepare(`
      INSERT INTO paper_positions (wallet_address, token_address, token_symbol, buy_price_sol, buy_amount_sol, buy_amount_tokens, buy_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `).run(
      trade.walletAddress,
      trade.tokenAddress,
      trade.tokenSymbol || 'UNKNOWN',
      trade.priceSol,
      amountSol,
      trade.amountTokens,
      trade.timestamp
    );

    console.log(`📝 Paper BUY: ${trade.tokenSymbol} — ${amountSol.toFixed(4)} SOL`);

    return {
      success: true,
      action: 'BUY',
      mode: 'paper',
      token: trade.tokenSymbol,
      amount: amountSol,
    };
  }

  /**
   * Paper sell (no real execution)
   */
  paperSell(trade) {
    const position = db.prepare(`
      SELECT * FROM paper_positions 
      WHERE wallet_address = ? AND token_address = ? AND status = 'OPEN'
      ORDER BY buy_time DESC LIMIT 1
    `).get(trade.walletAddress, trade.tokenAddress);

    if (!position) {
      return { success: false, error: 'No open position' };
    }

    const pnlSol = trade.amountSol - position.buy_amount_sol;
    const pnlPercent = position.buy_price_sol > 0 ? ((trade.priceSol - position.buy_price_sol) / position.buy_price_sol) * 100 : 0;

    db.prepare(`
      UPDATE paper_positions 
      SET sell_price_sol = ?, sell_amount_sol = ?, sell_time = ?, 
          pnl_sol = ?, pnl_percent = ?, status = 'CLOSED'
      WHERE id = ?
    `).run(trade.priceSol, trade.amountSol, trade.timestamp, pnlSol, pnlPercent, position.id);

    const emoji = pnlSol >= 0 ? '💰' : '📉';
    console.log(`📝 Paper SELL: ${trade.tokenSymbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`);

    return {
      success: true,
      action: 'SELL',
      mode: 'paper',
      token: trade.tokenSymbol,
      pnl: pnlSol,
      pnlPercent: pnlPercent,
    };
  }

  /**
   * Save executed trade to database
   */
  saveTrade(trade, action, amountSol, bundleId) {
    db.prepare(`
      INSERT INTO trades (wallet_address, token_address, token_symbol, token_name, action, amount_sol, amount_tokens, price_sol, detected_at, tx_signature, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.walletAddress,
      trade.tokenAddress,
      trade.tokenSymbol || 'UNKNOWN',
      trade.tokenName || '',
      action,
      amountSol,
      trade.amountTokens,
      trade.priceSol,
      trade.timestamp,
      bundleId || '',
      JSON.stringify(trade)
    );
  }

  /**
   * Check stop-loss and take-profit for all open positions
   */
  async checkRiskManagement() {
    if (this.mode !== 'live' || !this.wallet) return;

    const openPositions = db.prepare(`
      SELECT * FROM paper_positions WHERE status = 'OPEN' AND wallet_address = ?
    `).all(this.wallet.publicKey.toString());

    for (const position of openPositions) {
      try {
        // Get current token price
        const priceUrl = `https://price.jup.ag/v6/price?ids=${position.token_address}&vsToken=${SOL_MINT}`;
        const priceResp = await fetch(priceUrl);
        const priceData = await priceResp.json();
        const currentPrice = priceData.data?.[position.token_address]?.price || 0;

        if (currentPrice <= 0) continue;

        const currentValueSol = position.buy_amount_tokens * currentPrice;
        const pnlPercent = ((currentValueSol - position.buy_amount_sol) / position.buy_amount_sol) * 100;

        // Stop-loss check
        if (pnlPercent <= -this.stopLossPercent) {
          console.log(`🛑 STOP-LOSS triggered for ${position.token_symbol}: ${pnlPercent.toFixed(1)}%`);
          // Auto-sell would go here
        }

        // Take-profit check
        if (pnlPercent >= this.takeProfitPercent) {
          console.log(`🎯 TAKE-PROFIT triggered for ${position.token_symbol}: +${pnlPercent.toFixed(1)}%`);
          // Auto-sell would go here
        }
      } catch (e) {
        // Price check failed, skip
      }
    }
  }

  /**
   * Get executor status
   */
  getStatus() {
    return {
      mode: this.mode,
      walletConfigured: !!this.wallet,
      jitoConfigured: !!this.jito,
      maxPositionSol: this.maxPositionSol,
      slippageBps: this.slippageBps,
      stopLossPercent: this.stopLossPercent,
      takeProfitPercent: this.takeProfitPercent,
    };
  }
}

module.exports = { TradeExecutor };
