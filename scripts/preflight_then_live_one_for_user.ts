#!/usr/bin/env ts-node
require('dotenv').config();

async function main(){
  try{
    const sniperMod = require('../sniper');
    if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
      console.error('sniper.collectFreshMints not available'); process.exit(1);
    }

    const users = require('../users.json');
    const uid = Object.keys(users)[0];
    const user = users[uid];
    if(!user){ console.error('No user found'); process.exit(2); }

    console.log('Preflight -> Live (one) run for user', uid, 'wallet=', user.wallet);

    // 1) Collect fresh mints
    const maxCollect = 3;
    console.log('Collecting up to', maxCollect, 'fresh mints...');
    const collected = await sniperMod.collectFreshMints({ maxCollect, timeoutMs: 20000 });
    if(!collected || collected.length === 0){ console.error('No fresh mints found'); process.exit(3); }
    console.log('Collected mints:', JSON.stringify(collected.map((c: any) => c.mint || c.tokenAddress || c.address || c)));

    // Normalize tokens
    const tokens = collected.map((tok: any) => ({
      mint: tok.mint || tok.tokenAddress || tok.address || tok,
      createdAt: tok.firstBlockTime || tok.firstBlock || null,
      ageMinutes: tok._canonicalAgeSeconds ? (tok._canonicalAgeSeconds/60) : null,
      __listenerCollected: true,
    }));

    // 2) Simulation phase (dry-run)
    process.env.LIVE_TRADES = 'false';
    console.log('\n--- Running preflight simulation (dry-run) ---');
    const { autoExecuteStrategyForUser } = await import('../src/autoStrategyExecutor');
    const simResults = await autoExecuteStrategyForUser(user, tokens, 'buy', { simulateOnly: true, listenerBypass: true });
    console.log('Simulation results:');
    console.log(JSON.stringify(simResults, null, 2));

    const passed = [] as any[];
    for(const r of simResults){
      if(r && r.result && (r.result.success === true || (r.result.tx && String(r.result.tx).startsWith('DRY-RUN')))){
        passed.push(r.token || r.tokenMint || r.tokenAddress || r);
      }
    }
    console.log(`Simulation passed for ${passed.length}/${tokens.length} tokens.`);
    if(passed.length === 0){ console.log('No tokens passed simulation — aborting live sends.'); process.exit(0); }

    // Only take the first passed token for a cautious live test
    // If the simulation already performed an immediate live buy for the first passed token, skip live phase
    const firstPassed = passed[0];
    const wasImmediate = Array.isArray(simResults) && simResults.some((s:any)=>s && s.token === firstPassed && s.immediateLive);
    if(wasImmediate){
      console.log('First passed token was already bought during simulation (immediateLive). Skipping live buy.');
      process.exit(0);
    }
    const tokenToBuyMint = firstPassed;
    console.log('Selected first passed token for live buy:', tokenToBuyMint);

    // Require explicit CONFIRM_LIVE=true to allow actual on-chain sends.
    if (process.env.CONFIRM_LIVE !== 'true') {
      console.log('\n--- Live phase skipped: CONFIRM_LIVE is not set to "true" ---');
      console.log('To perform this single live send, re-run with CONFIRM_LIVE=true and ensure you accept fees (LIVE_TRADES will be enabled).');
      process.exit(0);
    }

    // 3) Live phase for single token
    process.env.LIVE_TRADES = 'true';
    console.log('\n--- Performing LIVE buy for single token ---');
    const tokensToBuy = tokens.filter((t: any) => t.mint === tokenToBuyMint);
    const liveResults = await autoExecuteStrategyForUser(user, tokensToBuy, 'buy', { simulateOnly: false, listenerBypass: true });
    console.log('Live execution results:');
    console.log(JSON.stringify(liveResults, null, 2));

    // 4) Fetch on-chain details for returned txid if any
    const rpcPool = require('../src/utils/rpcPool').default;
    const conn = rpcPool.getRpcConnection();
    for(const r of liveResults){
      try{
        const txid = r && r.result && r.result.tx ? r.result.tx : null;
        if(!txid || String(txid).startsWith('DRY-RUN')) continue;
        console.log('\nFetching on-chain details for tx:', txid);
        const tx = await conn.getTransaction(txid, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 } as any);
        if(!tx){ console.log('No transaction details available yet for', txid); continue; }
        const fee = tx.meta && typeof tx.meta.fee === 'number' ? tx.meta.fee : null;
        const logs = tx.meta && tx.meta.logMessages ? tx.meta.logMessages : null;
        console.log('  fee (lamports):', fee, ' (SOL =', fee ? fee/1e9 : 'n/a', ')');
        if(logs) console.log('  logs (first 20 lines):\n', logs.slice(0,20).join('\n'));
      }catch(e){ console.warn('Failed to fetch on-chain details for result', r, String(e)); }
    }

    console.log('\nDone. Summary:');
    console.log('  Collected:', tokens.length);
    console.log('  Simulated passes:', passed.length);
    console.log('  Live attempts:', liveResults.length);
    process.exit(0);
  }catch(e){ console.error('Script failed:', String(e)); process.exit(11); }
}

main();
