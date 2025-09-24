#!/usr/bin/env ts-node
require('dotenv').config();

async function main(){
  const rpcPool = require('../src/utils/rpcPool').default;
  const sniper = require('../sniper');
  const { createJupiterApiClient } = require('@jup-ag/api');
  const { Keypair, VersionedTransaction, Transaction, PublicKey } = require('@solana/web3.js');
  const users = require('../users.json');
  const uid = Object.keys(users)[0];
  const user = users[uid];
  if(!user) { console.error('No user'); process.exit(1); }

  console.log('Using wallet:', user.wallet);
  const collected = await sniper.collectFreshMints({ maxCollect: 1, timeoutMs: 20000 });
  if(!collected || collected.length === 0) { console.error('No fresh mints found'); process.exit(2); }
  const mint = collected[0].mint || collected[0].tokenAddress || collected[0].address || collected[0];
  console.log('Collected mint:', mint);

  const conn = rpcPool.getRpcConnection();
  const jupiter = createJupiterApiClient();
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  // prepare keypair
  const secretKey = Buffer.from(user.secret, 'base64');
  const kp = Keypair.fromSecretKey(secretKey);

  console.log('Requesting quote and swap transaction for', mint);
  const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: Math.floor((user.strategy?.buyAmount||0.001)*1e9), slippageBps: 100 });
  console.log('Quote:', quote ? ('outAmount=' + quote.outAmount) : 'no quote');
  const swapResp = await jupiter.swapPost({ swapRequest: { userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, asLegacyTransaction: false, quoteResponse: quote } });
  if(!swapResp || !swapResp.swapTransaction){ console.error('No swap transaction'); process.exit(3); }
  const swapBuf = Buffer.from(swapResp.swapTransaction, 'base64');

  // Attempt to parse as VersionedTransaction
  try{
    const vt = VersionedTransaction.deserialize(swapBuf);
    console.log('Parsed VersionedTransaction. Message staticAccountKeys length:', vt.message.staticAccountKeys.length);
    console.log('Message header:', vt.message.header);
  console.log('Account keys (first 20):', vt.message.staticAccountKeys.slice(0,20).map((k: any) => k.toBase58()));
    console.log('Signatures length:', vt.signatures.length);
  console.log('Signatures (placeholder):', vt.signatures.map((s: any) => s ? s.toString('hex').slice(0,8) : null));

    // Try signing locally
    try{
      vt.sign([kp]);
  const signed = vt.serialize();
  console.log('Signed locally. New signatures (first):', vt.signatures.map((s: any) => s ? s.toString('hex').slice(0,8) : null));
      // simulate
      const simTx = VersionedTransaction.deserialize(signed);
      const sim = await conn.simulateTransaction(simTx);
      console.log('simulateTransaction result:', sim.value.err ? ('ERR ' + JSON.stringify(sim.value.err)) : 'OK');
      if(sim.value.logs) console.log('Logs (first 20):\n', sim.value.logs.slice(0,20).join('\n'));
    }catch(e){ console.error('Local signing or simulation failed:', e); }
  }catch(e){
    console.log('Failed to parse as VersionedTransaction, trying legacy Transaction');
    try{
      const legacy = Transaction.from(swapBuf);
      console.log('Parsed legacy Transaction. signatures length:', legacy.signatures.length);
      try{ legacy.sign(kp); const signed = legacy.serialize(); console.log('Legacy signed.'); const sim = await conn.simulateTransaction(legacy); console.log('simulateTransaction result:', sim.value.err ? ('ERR ' + JSON.stringify(sim.value.err)) : 'OK'); if(sim.value.logs) console.log('Logs (first 20):\n', sim.value.logs.slice(0,20).join('\n')); }catch(e){ console.error('Legacy sign/sim failed', e); }
    }catch(ee){ console.error('Unable to parse swap transaction:', ee); }
  }
  process.exit(0);
}

main().catch(e=>{ console.error('Script failed', e); process.exit(11); });
