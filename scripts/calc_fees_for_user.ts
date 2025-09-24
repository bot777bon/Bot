#!/usr/bin/env ts-node
require('dotenv').config();

import fs from 'fs';
import path from 'path';
const rpcPool = require('../src/utils/rpcPool').default;

async function main(){
  try{
    const usersPath = path.resolve(process.cwd(),'users.json');
    if(!fs.existsSync(usersPath)){
      console.error('users.json not found'); process.exit(2);
    }
    const users = JSON.parse(fs.readFileSync(usersPath,'utf8'));
    const uid = process.argv[2] || Object.keys(users)[0];
    if(!uid){ console.error('No user id provided and users.json empty'); process.exit(3); }
    const user = users[uid];
    if(!user){ console.error('User not found:', uid); process.exit(4); }

    const conn = rpcPool.getRpcConnection();

    // Gather txids from history entries and from optional argument list
    const txs = new Set<string>();
    const hist: string[] = Array.isArray(user.history) ? user.history : [];
    const txRegex = /([1-9A-HJ-NP-Za-km-z]{30,120})/g; // broad base58-ish match
    for(const entry of hist){
      if(!entry || typeof entry !== 'string') continue;
      const m = entry.match(txRegex);
      if(m){
        for(const tok of m){
          if(String(tok).toUpperCase().includes('DRY-RUN')) continue;
          txs.add(tok);
        }
      }
    }

    // Also accept txids passed on command line after user id
    if(process.argv.length > 2){
      for(let i=3;i<process.argv.length;i++) txs.add(process.argv[i]);
    }

    if(txs.size === 0){
      console.log('No on-chain txids found in user.history. Provide txids as additional args to inspect.');
      console.log('Example: node ./scripts/calc_fees_for_user.ts 5766632997 <txid1> <txid2>');
      process.exit(0);
    }

    console.log('Using RPC:', rpcPool.getLastUsedUrl ? rpcPool.getLastUsedUrl() : 'unknown');
    let totalLamports = 0;
    const details: Array<{tx:string, fee:number|null, err?:string}> = [];
    for(const txid of Array.from(txs)){
      try{
        console.log('Fetching tx', txid);
        const tx = await conn.getTransaction(txid, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 } as any);
        if(!tx){
          details.push({tx: txid, fee:null, err: 'not found or not yet confirmed'});
          continue;
        }
        const fee = tx.meta && typeof tx.meta.fee === 'number' ? tx.meta.fee : null;
        details.push({tx: txid, fee});
        if(typeof fee === 'number') totalLamports += fee;
      }catch(e:any){
        details.push({tx: txid, fee: null, err: String(e && e.message ? e.message : e)});
      }
    }

    console.log('\nPer-tx fee details:');
    for(const d of details){
      console.log(' -', d.tx, 'fee(lamports)=', d.fee, d.err ? ' err='+d.err : '');
    }
    console.log('\nTotal fee (lamports):', totalLamports, ' (SOL =', (totalLamports/1e9), ')');
    console.log('\nNotes:');
    console.log(' - On-chain transaction fees (tx.meta.fee) are paid to the Solana network (validators) and are not credited to any wallet in the code unless an explicit transfer instruction exists.');
    console.log(' - If you expected the bot wallet to "receive a portion of fees", that behavior is not implemented: variables like FEE_RECIPIENT / RESERVE_WALLET exist in config but no code sends collected fees there.');
    console.log(' - Some program-level fees (e.g., prioritization tip) may be sent to validator or a service (Jito) depending on RPC/program; they are still not auto-credited to the bot wallet by this codebase.');

    process.exit(0);
  }catch(e){ console.error('Script failed:', String(e)); process.exit(11); }
}

main();
