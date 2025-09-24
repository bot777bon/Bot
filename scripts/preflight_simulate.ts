import fs from 'fs';

process.env.LIVE_TRADES = process.env.LIVE_TRADES || 'false';
(async function(){
  const users = JSON.parse(fs.readFileSync('users.json','utf8'));
  const uid = Object.keys(users)[0];
  const user = users[uid];
  console.log('Preflight simulate for user', uid, 'LIVE_TRADES=', process.env.LIVE_TRADES);

  // require sniper module to collect fresh mints
  const sniperMod = require('../sniper.js');
  if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
    console.error('sniper.collectFreshMints not available');
    process.exit(1);
  }
  console.log('Collecting fresh mints (max 3, timeout 20s)...');
  const collected = await sniperMod.collectFreshMints({ maxCollect: 3, timeoutMs: 20000 });
  console.log('Collected:', collected.map((c:any)=>c.mint||c.tokenAddress||c.address||c));

  const tokens = Array.isArray(collected) ? collected.map((t:any) => {
    const mint = t.mint || t.tokenAddress || t.address || t;
    const firstBlock = (t && (t.firstBlockTime || t.firstBlock || t.first_block_time)) || null;
    // Normalize to ms timestamp if the collector gave seconds
    const createdAtMs = firstBlock ? (Number(firstBlock) > 1e12 ? Number(firstBlock) : Number(firstBlock) * 1000) : null;
    const canonicalSec = (t && (t._canonicalAgeSeconds || t.ageSeconds || t._canonical_age_seconds)) || null;
    const ageMinutes = (typeof canonicalSec === 'number' && !isNaN(canonicalSec)) ? Math.floor(canonicalSec / 60) : (createdAtMs ? Math.floor((Date.now() - createdAtMs) / 60000) : undefined);
    const ageField = typeof ageMinutes === 'number' && !isNaN(ageMinutes) ? ageMinutes : undefined;
    return {
      tokenAddress: mint,
      address: mint,
      mint: mint,
      firstBlockTime: createdAtMs,
      createdAt: createdAtMs,
      _canonicalAgeSeconds: canonicalSec,
      ageMinutes: ageField,
      age: ageField,
      sampleLogs: t.sampleLogs
    };
  }) : [];

  const { autoExecuteStrategyForUser } = await import('../src/autoStrategyExecutor');
  try{
      // Simulate the sniper-button / listener flow: bypass strategy filtering (listener provides tokens)
    const res = await autoExecuteStrategyForUser(user, tokens, 'buy', { simulateOnly: true, listenerBypass: true });
    console.log('Preflight simulation results:');
    console.log(JSON.stringify(res, null, 2));
    // If all results are simulated success, exit with code 0 but do NOT perform actual sends
    const anyFailures = Array.isArray(res) && res.some((r:any)=> (r.result && r.result.success) !== true );
    if(!anyFailures){
      console.log('Simulation indicates success for all tokens. No on-chain sends were performed because simulateOnly=true and LIVE_TRADES!=true.');
    } else {
      console.log('Some tokens failed simulation or returned errors. Review details above.');
    }
    process.exit(0);
  }catch(e){ console.error('Error running auto-exec preflight', e); process.exit(1); }
})();
