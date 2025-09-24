(async () => {
  process.env.LIVE_TRADES = 'false';
  process.env.HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
  // load user
  const fs = require('fs');
  const users = JSON.parse(fs.readFileSync('users.json','utf8'));
  const uid = Object.keys(users)[0];
  const user = users[uid];
  const tokens = [];
  const files = fs.readdirSync('out/capture_queue');
  for(const f of files){
    try{ const p = JSON.parse(fs.readFileSync('out/capture_queue/'+f,'utf8')); if(Array.isArray(p.mints)) for(const m of p.mints) tokens.push({ mint: m, tokenAddress: m, name: m }); }catch(e){}
  }
  console.log('Simulating autoExecute for user', uid, 'tokens:', tokens.map(t=>t.mint));
  const execMod = require('./src/autoStrategyExecutor');
  try{
    await execMod.autoExecuteStrategyForUser(user, tokens, 'buy');
    console.log('autoExecute finished');
  }catch(e){ console.error('autoExecute error', e); }
})();