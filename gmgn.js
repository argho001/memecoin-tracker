/**
 * GMGN OpenAPI Client — with Key Rotation
 *
 * Rotates between multiple API keys to maximize rate limit usage.
 * GMGN: capacity=20, rate=20, wallet_activity weight=3
 * 2 keys → ~12 calls per burst, 3 keys → ~18 calls per burst
 */

const axios = require('axios');
const crypto = require('crypto');

const GMGN_HOST = 'https://openapi.gmgn.ai';

class GmgnClient {
  constructor(apiKeys) {
    // Support single key or array of keys
    this.keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];
    this.keyIndex = 0;

    this.client = axios.create({
      baseURL: GMGN_HOST,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'gmgn-tracker/1.0',
      },
    });
  }

  /**
   * Get next API key (round-robin rotation)
   */
  _nextKey() {
    const key = this.keys[this.keyIndex % this.keys.length];
    this.keyIndex++;
    return key;
  }

  /**
   * Build auth query params
   */
  _authParams() {
    return {
      timestamp: Math.floor(Date.now() / 1000),
      client_id: crypto.randomUUID(),
    };
  }

  /**
   * GET request with key rotation
   */
  async _get(path, params = {}) {
    const auth = this._authParams();
    const allParams = { ...params, ...auth };
    const key = this._nextKey();

    const { data } = await this.client.get(path, {
      params: allParams,
      headers: { 'X-APIKEY': key },
    });

    if (data.code !== 0 && data.code !== '0') {
      throw new Error(data.message || data.error || `GMGN API error: ${data.code}`);
    }
    return data.data;
  }

  /**
   * POST request with key rotation
   */
  async _post(path, body, queryParams = {}) {
    const auth = this._authParams();
    const allParams = { ...queryParams, ...auth };
    const key = this._nextKey();

    const { data } = await this.client.post(path, body, {
      params: allParams,
      headers: { 'X-APIKEY': key },
    });

    if (data.code !== 0 && data.code !== '0') {
      throw new Error(data.message || data.error || `GMGN API error: ${data.code}`);
    }
    return data.data;
  }

  // ── Wallet Activity ──────────────────────────────────────────
  async getWalletActivity(wallet, opts = {}) {
    const params = {
      wallet_address: wallet,
      chain: 'sol',
      limit: opts.limit || 20,
    };
    if (opts.cursor) params.cursor = opts.cursor;
    if (opts.type) params.type = Array.isArray(opts.type) ? opts.type.join(',') : opts.type;
    if (opts.token) params.token = opts.token;
    return this._get('/v1/user/wallet_activity', params);
  }

  // ── Wallet Stats ─────────────────────────────────────────────
  async getWalletStats(wallet, period = '7d') {
    return this._get('/v1/user/wallet_stats', {
      wallet_address: wallet,
      chain: 'sol',
      period,
    });
  }

  // ── Wallet Holdings ──────────────────────────────────────────
  async getWalletHoldings(wallet, opts = {}) {
    return this._get('/v1/user/wallet_holdings', {
      wallet_address: wallet,
      chain: 'sol',
      limit: opts.limit || 20,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
  }

  // ── Trending Tokens ──────────────────────────────────────────
  async getTrending(interval = '1h', opts = {}) {
    return this._get('/v1/market/rank', {
      chain: 'sol',
      interval,
      limit: opts.limit || 50,
      order_by: opts.orderBy || 'swaps',
      direction: 'desc',
    });
  }

  // ── Token K-line ─────────────────────────────────────────────
  async getTokenKline(tokenAddress, resolution = '1h') {
    return this._get('/v1/market/token_kline', {
      chain: 'sol',
      address: tokenAddress,
      resolution,
    });
  }

  // ── Token Signal ─────────────────────────────────────────────
  async getTokenSignals() {
    return this._post('/v1/market/token_signal', { chain: 'sol' });
  }

  // ── Smart Money ──────────────────────────────────────────────
  async getSmartMoney(limit = 50) {
    return this._get('/v1/user/smartmoney', { chain: 'sol', limit });
  }

  // ── KOL ──────────────────────────────────────────────────────
  async getKol(limit = 50) {
    return this._get('/v1/user/kol', { chain: 'sol', limit });
  }

  // ── User Info ────────────────────────────────────────────────
  async getUserInfo() {
    return this._get('/v1/user/info');
  }

  // ── Key Status ───────────────────────────────────────────────
  getKeyCount() {
    return this.keys.length;
  }
}

module.exports = { GmgnClient };
