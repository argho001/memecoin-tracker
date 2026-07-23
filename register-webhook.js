require('dotenv').config();
const axios = require('axios');
const db = require('./db');

const HELIUS = 'https://api.helius.xyz/v0';
const WEBHOOK_URL = 'http://bore.pub:9880/api/webhook';

async function register() {
  const wallets = db.prepare('SELECT address FROM tracked_wallets WHERE active = 1').all().map(w => w.address);
  console.log('Wallets to track:', wallets.length);
  wallets.forEach((w, i) => console.log(`  ${i+1}. ${w}`));

  // Delete existing webhooks
  try {
    const url = HELIUS + '/webhooks?api-key=' + process.env.HELIUS_API_KEY;
    const existing = await axios.get(url);
    for (const wh of (existing.data || [])) {
      const delUrl = HELIUS + '/webhooks/' + wh.webhookID + '?api-key=' + process.env.HELIUS_API_KEY;
      await axios.delete(delUrl);
      console.log('Deleted old webhook:', wh.webhookID);
    }
  } catch (e) {
    console.log('No existing webhooks to delete');
  }

  // Create new webhook
  try {
    const createUrl = HELIUS + '/webhooks?api-key=' + process.env.HELIUS_API_KEY;
    const resp = await axios.post(createUrl, {
      webhookURL: WEBHOOK_URL,
      transactionTypes: ['SWAP'],
      accountAddresses: wallets,
      webhookType: 'enhanced',
    });

    console.log('\n✅ Webhook registered!');
    console.log('   ID:', resp.data.webhookID);
    console.log('   URL:', WEBHOOK_URL);
    console.log('   Tracking:', wallets.length, 'wallets');
    console.log('   Type: enhanced (auto-decoded swaps)');
    console.log('\n🎯 Trades will now be pushed instantly — zero polling!');
  } catch (e) {
    console.error('❌ Failed:', e.response ? JSON.stringify(e.response.data) : e.message);
  }
}

register();
