import fs from 'fs';

// Ensure dry-run
process.env.LIVE_TRADES = 'false';
process.env.HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
process.env.CAPTURE_ONLY = 'false';

async function main(){
  const users = JSON.parse(fs.readFileSync('users.json','utf8'));
  const uid = Object.keys(users)[0];
  const user = users[uid];
  console.log('User:', uid);

  // require sniper module
  const sniperMod = require('../sniper.js');
  if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
    console.error('sniper.collectFreshMints not available');
    return;
  }

  console.log('Collecting fresh mints (max 3, timeout 20s)...');
  const collected = await sniperMod.collectFreshMints({ maxCollect: 3, timeoutMs: 20000 });
  console.log('Collected:', collected);
  // Prepare tokens preserving freshness metadata so strategy filters can compute age
  const tokens = Array.isArray(collected) ? collected.map((t:any) => {
    const mint = t.mint || t.tokenAddress || t.address || t;
    const firstBlockTime = (t && (t.firstBlockTime || t.firstBlock || t.first_block_time)) || null;
    const canonicalSec = (t && (t._canonicalAgeSeconds || t.ageSeconds || t._canonical_age_seconds)) || null;
    const ageMinutes = (typeof canonicalSec === 'number' && !isNaN(canonicalSec)) ? Math.floor(canonicalSec / 60) : (firstBlockTime ? Math.floor((Date.now() - Number(firstBlockTime)) / 60000) : undefined);
    return { tokenAddress: mint, address: mint, mint: mint, firstBlockTime, _canonicalAgeSeconds: canonicalSec, ageMinutes };
  }) : [];
  console.log('Prepared tokens for simulation:', tokens.map((t:any)=>t.mint));

  const { autoExecuteStrategyForUser } = await import('../src/autoStrategyExecutor');
  try{
    await autoExecuteStrategyForUser(user, tokens, 'buy');
    console.log('autoExecute finished');
  }catch(e){ console.error('autoExecute error', e); }
}

main().catch(e=>{ console.error('script failed', e); process.exit(1); });
