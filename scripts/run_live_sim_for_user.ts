import fs from 'fs';

process.env.LIVE_TRADES = process.env.LIVE_TRADES || 'false';
(async function(){
  const users = JSON.parse(fs.readFileSync('users.json','utf8'));
  const uid = Object.keys(users)[0];
  const user = users[uid];
  console.log('Running live-sim for user', uid, 'LIVE_TRADES=', process.env.LIVE_TRADES);

  // Build simulated token list (these are sample mints; adjust if you want real captured mints)
  const now = Date.now();
  const tokens = [
    { tokenAddress: 'EMg2QkFZ6pLvgckVGj8X6nmyrkiuoamYnTdoxXN8pump', address: 'EMg2QkFZ6pLvgckVGj8X6nmyrkiuoamYnTdoxXN8pump', mint: 'EMg2QkFZ6pLvgckVGj8X6nmyrkiuoamYnTdoxXN8pump', firstBlockTime: now - (60*1000), ageMinutes: 1, age:1, _canonicalAgeSeconds: 60 },
    { tokenAddress: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', address: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', firstBlockTime: now - (120*1000), ageMinutes: 2, age:2, _canonicalAgeSeconds: 120 }
  ];

  console.log('Simulated tokens:', tokens.map(t=>t.mint));
  try{
    const mod = await import('../src/autoStrategyExecutor');
    const fn = mod.autoExecuteStrategyForUser || (mod as any).default;
    if(typeof fn !== 'function'){
      console.error('autoExecuteStrategyForUser not found'); process.exit(1);
    }
    await fn(user, tokens, 'buy');
    console.log('Simulation finished');
  }catch(e){ console.error('Error running auto-exec', e); process.exit(1); }
})();
