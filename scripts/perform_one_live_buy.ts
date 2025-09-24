#!/usr/bin/env ts-node
require('dotenv').config();
// Intentionally enable live trades for this one-off run. User explicitly requested a real execution.
process.env.LIVE_TRADES = 'true';

async function main(){
  try{
    console.log('Performing one live buy run. LIVE_TRADES=', process.env.LIVE_TRADES);
    const sniperMod = require('../sniper');
    if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
      console.error('sniper.collectFreshMints not available'); process.exit(1);
    }
    console.log('Collecting one fresh mint (timeout 20s)...');
    const collected = await sniperMod.collectFreshMints({ maxCollect: 1, timeoutMs: 20000 });
    if(!collected || collected.length === 0){
      console.error('No fresh mints collected. Aborting live run.'); process.exit(2);
    }
    const tok = collected[0];
    // Normalize token object expected by autoExecuteStrategyForUser
    const tokenObj = {
      mint: tok.mint || tok.tokenAddress || tok.address || tok,
      createdAt: tok.firstBlockTime || tok.firstBlock || null,
      ageMinutes: tok._canonicalAgeSeconds ? (tok._canonicalAgeSeconds / 60) : null,
      __listenerCollected: true,
    };

    // Load users.json and pick the known user id
    const users = require('../users.json');
    const uid = Object.keys(users)[0];
    const user = users[uid];
    if(!user){
      console.error('No user found in users.json'); process.exit(3);
    }
    console.log('Using user', uid, 'wallet=', user.wallet);

    const { autoExecuteStrategyForUser } = await import('../src/autoStrategyExecutor');
    if(!autoExecuteStrategyForUser){ console.error('autoExecuteStrategyForUser not found'); process.exit(4); }

    console.log('Executing live buy for token', tokenObj.mint);
    const res = await autoExecuteStrategyForUser(user, [tokenObj], 'buy', { simulateOnly: false, listenerBypass: true });
    console.log('Executor returned:', JSON.stringify(res, null, 2));
    if(Array.isArray(res) && res.length>0){
      const r = res[0];
      if(r && r.result && r.result.tx){
        console.log('Live transaction signature:', r.result.tx);
      }
    }
    process.exit(0);
  }catch(e){
    console.error('Live buy script failed:', String(e));
    process.exit(5);
  }
}

main();
