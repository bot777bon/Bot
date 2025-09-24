import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import rpcPool from '../src/utils/rpcPool';

process.env.LIVE_TRADES = 'false';
// Use centralized rpcPool to obtain a Connection (rotation/backoff applied)
const conn = rpcPool.getRpcConnection();

async function getFirstBlockMs(mint:string){
  try{
    const pk = new PublicKey(mint);
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 1 });
    if(Array.isArray(sigs) && sigs.length>0){
      const bt = sigs[0].blockTime || null;
      if(bt) return Number(bt) * 1000;
    }
  }catch(e){ /* ignore */ }
  return null;
}

async function main(){
  const users = JSON.parse(fs.readFileSync('users.json','utf8'));
  const uid = Object.keys(users)[0];
  const user = users[uid];
  console.log('Simulating for user', uid);

  const outDir = path.join(process.cwd(), 'out', 'capture_queue');
  if(!fs.existsSync(outDir)){
    console.error('No capture queue directory found:', outDir); process.exit(1);
  }
  const files = fs.readdirSync(outDir).filter(f=>f.endsWith('.json'));
  if(files.length===0){ console.error('No capture files'); process.exit(1); }
  const tokens: any[] = [];
  for(const f of files){
    try{
      const data = JSON.parse(fs.readFileSync(path.join(outDir,f),'utf8'));
      const mints = data.mints || data.fresh || data.freshMints || [];
      for(const m of mints){
        const firstBlockMs = await getFirstBlockMs(m).catch(()=>null);
  const ageSec = firstBlockMs ? ((Date.now() - firstBlockMs)/1000) : null;
  const ageMinutes = (ageSec !== null && ageSec !== undefined) ? Math.floor(ageSec / 60) : null;
  tokens.push({ tokenAddress: m, address: m, mint: m, firstBlockTime: firstBlockMs, _canonicalAgeSeconds: ageSec, ageMinutes: ageMinutes, age: ageMinutes, createdAt: firstBlockMs || null, sampleLogs: data.sampleLogs || [] });
      }
    }catch(e){}
  }
  console.log('Enriched tokens:', tokens.map(t=>t.mint));

  const { autoExecuteStrategyForUser } = await import('../src/autoStrategyExecutor');
  try{
    await autoExecuteStrategyForUser(user, tokens, 'buy');
    console.log('autoExecute finished');
  }catch(e){ console.error('autoExecute error', e); }
}

main().catch(e=>{ console.error(e); process.exit(1); });
